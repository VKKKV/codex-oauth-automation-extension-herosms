const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/signup-page.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

test('signup entry diagnostics summarizes current page inputs and visible actions', () => {
const api = new Function(`
const SIGNUP_ENTRY_TRIGGER_PATTERN = /免费注册|立即注册|注册|sign\\s*up|register|create\\s*account|create\\s+account/i;
const location = { href: 'https://chatgpt.com/' };
const document = {
  title: 'ChatGPT',
  readyState: 'complete',
  querySelector() {
    return null;
  },
  querySelectorAll(selector) {
    if (selector === 'a, button, [role="button"], [role="link"], input[type="button"], input[type="submit"]') {
      return [
        {
          tagName: 'BUTTON',
          textContent: 'Get started',
          disabled: false,
          getBoundingClientRect() {
            return { width: 120, height: 40 };
          },
          getAttribute(name) {
            return name === 'type' ? 'button' : '';
          },
        },
        {
          tagName: 'A',
          textContent: 'Log in',
          disabled: false,
          getBoundingClientRect() {
            return { width: 96, height: 40 };
          },
          getAttribute() {
            return '';
          },
        },
      ];
    }
    return [];
  },
};

function isVisibleElement() {
  return true;
}

function getActionText(el) {
  return [el?.textContent, el?.value, el?.getAttribute?.('aria-label'), el?.getAttribute?.('title')]
    .filter(Boolean)
    .join(' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function isActionEnabled(el) {
  return Boolean(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
}

function getSignupEmailInput() {
  return null;
}

function getSignupPasswordInput() {
  return null;
}

function getPageTextSnapshot() {
  return 'Welcome to ChatGPT. Try our latest models.';
}

${extractFunction('getSignupEntryDiagnostics')}

return {
  run() {
    return getSignupEntryDiagnostics();
  },
};
`)();

  const result = api.run();

  assert.equal(result.url, 'https://chatgpt.com/');
  assert.equal(result.title, 'ChatGPT');
  assert.equal(result.readyState, 'complete');
  assert.equal(result.hasEmailInput, false);
  assert.equal(result.hasPasswordInput, false);
  assert.equal(result.bodyContainsSignupText, false);
  assert.deepStrictEqual(result.signupLikeActions, []);
  assert.deepStrictEqual(result.visibleActions, [
    { tag: 'button', type: 'button', text: 'Get started', enabled: true },
    { tag: 'a', type: '', text: 'Log in', enabled: true },
  ]);
  assert.match(result.bodyTextPreview, /Welcome to ChatGPT/);
});
