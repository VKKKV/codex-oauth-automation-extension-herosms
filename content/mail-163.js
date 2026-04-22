// content/mail-163.js — Content script for 163 Mail (steps 4, 7)
// Injected on: mail.163.com

const MAIL163_PREFIX = '[MultiPage:mail-163]';
const isTopFrame = window === window.top;

console.log(MAIL163_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

// ============================================================
// Coordination (Top Frame Only)
// ============================================================

if (isTopFrame) {

let seenCodes = new Set();
async function loadSeenCodes() {
  try {
    const data = await chrome.storage.session.get('seenCodes');
    if (data.seenCodes && Array.isArray(data.seenCodes)) seenCodes = new Set(data.seenCodes);
  } catch (_) {}
}
loadSeenCodes();

async function persistSeenCodes() {
  try {
    await chrome.storage.session.set({ seenCodes: [...seenCodes] });
  } catch (_) {}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    resetStopState();
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ error: err.message, stopped: isStopError(err) });
    });
    return true;
  }
});

function extractVerificationCode(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.replace(/[\r\n\t\xa0]+/g, ' ').replace(/\s+/g, ' ').trim();
  const candidates = clean.match(/\b(\d{6})\b/g);
  if (!candidates) return null;
  
  // If multiple, prioritize the one near keywords
  for (const code of candidates) {
    const index = clean.indexOf(code);
    const context = clean.substring(Math.max(0, index - 100), index + 106);
    if (/(?:code|otp|verify|login|log-in|验证码|代码|openai)/i.test(context)) return code;
  }
  return candidates[candidates.length - 1]; // Fallback to last one (often the newest in body)
}

async function handlePollEmail(step, payload) {
  const { senderFilters, subjectFilters, maxAttempts, intervalMs, excludeCodes = [], filterAfterTimestamp = 0 } = payload;
  const excludedCodeSet = new Set(excludeCodes.map(c => String(c)));
  const filterAfterTime = normalizeSecondTimestamp(Number(filterAfterTimestamp) || 0);

  log(`步骤 ${step}：开始轮询 163 邮箱...`);
  
  if (step === 8) {
    await returnToInbox(step);
    log(`步骤 ${step}：登录验证，等待 8 秒待服务器推送...`);
    await sleep(8000);
  } else {
    await returnToInbox(step);
  }
  
  const existingMailIds = getCurrentMailIds();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`步骤 ${step}：正在轮询 163 邮箱，第 ${attempt}/${maxAttempts} 次`);

    await refreshInbox();
    await sleep(2500); // Wait for list to render

    const allItems = findMailItems();
    
    // STRATEGY: Find the SINGLE best match (topmost/newest)
    let bestCandidate = null;

    for (const item of allItems) {
      const id = item.getAttribute('id') || '';
      const mailTimestamp = getMailTimestamp(item);
      const mailTime = normalizeSecondTimestamp(mailTimestamp || 0);
      
      // Strict Time Filter: Arrived after request (with 5s drift grace)
      const passesTimeFilter = !filterAfterTime || (mailTime && mailTime >= (filterAfterTime - 5000));
      const isNewInList = !existingMailIds.has(id);
      
      // If it arrived after our request, it's a candidate regardless of snapshot
      if (passesTimeFilter || isNewInList || attempt > 3) {
        const sender = (item.querySelector('.nui-user')?.textContent || '').toLowerCase();
        const subject = item.querySelector('span.da0')?.textContent || '';
        const ariaLabel = (item.getAttribute('aria-label') || '').toLowerCase();

        const senderMatch = senderFilters.some(f => sender.includes(f.toLowerCase()) || ariaLabel.includes(f.toLowerCase()));
        const subjectMatch = subjectFilters.some(f => subject.toLowerCase().includes(f.toLowerCase()) || ariaLabel.includes(f.toLowerCase()));

        if (senderMatch || subjectMatch) {
          bestCandidate = { item, subject, mailTime, id };
          break; // Grab the TOPMOST matching email and STOP looking at older ones
        }
      }
    }

    if (bestCandidate) {
      const { item, subject, mailTime, id } = bestCandidate;
      log(`步骤 ${step}：找到匹配邮件 (时间: ${new Date(mailTime).toLocaleTimeString()})，检查内容...`);
      
      // 1. TRY EXTRACTING FROM SUBJECT (Fastest & Safest)
      let code = extractVerificationCode(subject);
      if (code && !excludedCodeSet.has(code) && !seenCodes.has(code)) {
        log(`步骤 ${step}：直接从邮件标题提取到验证码：${code}`, 'ok');
        seenCodes.add(code);
        persistSeenCodes();
        return { ok: true, code, emailTimestamp: mailTime, mailId: id };
      }

      // 2. TRY OPENING THE MAIL
      try {
        item.click();
        await sleep(3000); 

        code = null;
        for (let i = 0; i < 10; i++) {
          code = extractVerificationCode(document.body.innerText);
          if (!code) {
            document.querySelectorAll('iframe').forEach(f => {
              try {
                const doc = f.contentDocument || f.contentWindow.document;
                const frameCode = extractVerificationCode(doc.body.innerText);
                if (frameCode) code = frameCode;
              } catch (_) {}
            });
          }
          if (code) break;
          await sleep(1000);
        }

        if (code && !excludedCodeSet.has(code) && !seenCodes.has(code)) {
          seenCodes.add(code);
          persistSeenCodes();
          log(`步骤 ${step}：成功从详情提取验证码：${code}`, 'ok');
          await returnToInbox(step);
          scheduleEmailCleanup(item, step);
          return { ok: true, code, emailTimestamp: mailTime, mailId: id };
        } else {
          if (code) log(`步骤 ${step}：提取到码 ${code}，但识别为旧码或排除码，返回继续轮询。`, 'info');
          await returnToInbox(step);
          // Don't process other items in this attempt, wait for next refresh
        }
      } catch (err) {
        log(`步骤 ${step}：操作异常：${err.message}`, 'warn');
        await returnToInbox(step);
      }
    }

    if (attempt < maxAttempts) await sleep(intervalMs);
  }

  throw new Error(`在 ${maxAttempts} 次尝试后未找到新的匹配邮件。`);
}

function normalizeSecondTimestamp(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  const date = new Date(timestamp);
  date.setMilliseconds(0);
  return date.getTime();
}

function findMailItems() {
  return document.querySelectorAll('div[sign="letter"]');
}

function getCurrentMailIds() {
  const ids = new Set();
  findMailItems().forEach(item => {
    const id = item.getAttribute('id') || '';
    if (id) ids.add(id);
  });
  return ids;
}

function getMailTimestamp(item) {
  const candidates = [];
  const timeCell = item.querySelector('.e00[title], [title*="年"][title*=":"]');
  if (timeCell?.getAttribute('title')) candidates.push(timeCell.getAttribute('title'));
  if (timeCell?.textContent) candidates.push(timeCell.textContent);
  item.querySelectorAll('[title]').forEach(node => {
    const title = node.getAttribute('title');
    if (title) candidates.push(title);
  });
  for (const candidate of candidates) {
    const parsed = parseMail163Timestamp(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function parseMail163Timestamp(rawText) {
  const text = (rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  let match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/);
  if (match) {
    const [, year, month, day, hour, minute] = match;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0, 0).getTime();
  }
  match = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (match) {
    const [, hour, minute] = match;
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(hour), Number(minute), 0, 0).getTime();
  }
  return null;
}

function scheduleEmailCleanup(item, step) {
  setTimeout(() => {
    deleteEmail(item, step).catch(() => {});
  }, 0);
}

async function returnToInbox(step) {
  try {
    const inboxBtn = document.querySelector('#dvNavTree [title="收件箱"], .nui-tree-item-text[title="收件箱"]');
    if (inboxBtn) {
      inboxBtn.click();
      await sleep(2500); 
    }
  } catch (_) {}
}

async function deleteEmail(item, step) {
  try {
    item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(300);
    const trashIcon = item.querySelector('[sign="trash"], .nui-ico-delete, [title="删除邮件"]');
    if (trashIcon) {
      trashIcon.click();
      await sleep(1500);
      return;
    }
  } catch (_) {}
}

async function refreshInbox() {
  const toolbarBtns = document.querySelectorAll('.nui-btn .nui-btn-text');
  for (const btn of toolbarBtns) {
    if (btn.textContent.replace(/\s/g, '') === '刷新') {
      btn.closest('.nui-btn').click();
      await sleep(1500);
      return;
    }
  }
  const shouXinBtns = document.querySelectorAll('.ra0');
  for (const btn of shouXinBtns) {
    if (btn.textContent.replace(/\s/g, '').includes('收信')) {
      btn.click();
      await sleep(1500);
      return;
    }
  }
}

} // end of isTopFrame block
