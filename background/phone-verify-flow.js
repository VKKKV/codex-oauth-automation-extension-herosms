(function attachPhoneVerifyFlow(root, factory) {
  root.MultiPagePhoneVerifyFlow = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createPhoneVerifyFlowModule() {
  function createPhoneVerifyFlow(deps = {}) {
    const {
      addLog,
      HeroSmsUtils,
      loadHeroSmsConfig,
      loadLastActivation,
      saveLastActivation,
      clearLastActivation,
      sendToContentScriptResilient,
      sleepWithStop,
      throwIfStopped,
      fetchImpl,
    } = deps;

    if (typeof loadHeroSmsConfig !== 'function') {
      throw new Error('createPhoneVerifyFlow 需要 loadHeroSmsConfig 依赖');
    }
    if (!HeroSmsUtils) {
      throw new Error('createPhoneVerifyFlow 需要 HeroSmsUtils 依赖');
    }

    const REUSABLE_STATUSES = new Set(['WAIT_CODE', 'WAIT_RESEND', 'WAIT_RETRY']);

    const POLL_INTERVAL_MS = HeroSmsUtils.HERO_SMS_DEFAULT_POLL_INTERVAL_MS || 5000;
    const POLL_TIMEOUT_MS = HeroSmsUtils.HERO_SMS_DEFAULT_POLL_TIMEOUT_MS || 180000;
    const ADD_PHONE_FILL_TIMEOUT_MS = 15000;
    const ADD_PHONE_SUBMIT_TIMEOUT_MS = 20000;
    const ADD_PHONE_RESEND_TIMEOUT_MS = 15000;
    const FILL_CODE_TIMEOUT_MS = 20000;

    function httpOptions() {
      return fetchImpl ? { fetchImpl } : {};
    }

    async function safeCancelActivation(apiKey, activationId) {
      if (!apiKey || !activationId) return;
      try {
        await HeroSmsUtils.setStatus(apiKey, activationId, HeroSmsUtils.ACTIVATION_STATUS.CANCEL, httpOptions());
      } catch (err) {
        await addLog(`步骤 8：取消 HeroSMS 号码失败（可忽略）：${err?.message || err}`, 'warn');
      }
    }

    async function resolveMaxPrice(apiKey, service, country, configuredMaxPrice) {
      if (Number.isFinite(Number(configuredMaxPrice)) && Number(configuredMaxPrice) > 0) {
        return Number(configuredMaxPrice);
      }
      await addLog(`步骤 8：HeroSMS maxPrice 未填，尝试查询 ${service}/${country} 当前最低价...`, 'info');
      try {
        const { json } = await HeroSmsUtils.getPrices(apiKey, { service, country }, httpOptions());
        const lowest = HeroSmsUtils.pickLowestPrice(json, { service, country });
        if (lowest !== null) {
          await addLog(`步骤 8：HeroSMS 当前动态最低价为 ${lowest}。`, 'info');
          return lowest;
        }
      } catch (err) {
        await addLog(`步骤 8：HeroSMS 获取价格请求失败：${err?.message || err}`, 'warn');
      }
      return undefined; // Proceed without maxPrice to let API decide
    }

    async function sendAddPhoneMessage(type, payload, timeoutMs, logMessage) {
      const result = await sendToContentScriptResilient('signup-page', {
        type,
        source: 'background',
        payload: payload || {},
      }, {
        timeoutMs,
        responseTimeoutMs: timeoutMs,
        retryDelayMs: 600,
        logMessage,
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function pollSmsCode(apiKey, activationId, { round = 1 } = {}) {
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let attempt = 0;
      const maxAttempts = Math.max(1, Math.ceil(POLL_TIMEOUT_MS / POLL_INTERVAL_MS));
      while (Date.now() < deadline) {
        attempt += 1;
        throwIfStopped();
        await addLog(`步骤 8：HeroSMS 轮询短信验证码（第 ${round} 轮 第 ${attempt}/${maxAttempts} 次）...`, 'info');
        let status;
        try {
          status = await HeroSmsUtils.getStatus(apiKey, activationId, httpOptions());
        } catch (err) {
          await addLog(`步骤 8：HeroSMS getStatus 请求失败：${err?.message || err}`, 'warn');
          await sleepWithStop(POLL_INTERVAL_MS);
          continue;
        }
        if (status.status === 'OK') {
          return { ok: true, code: status.code };
        }
        if (status.status === 'CANCEL') {
          throw new Error('HeroSMS 活动已被取消。');
        }
        if (status.status === 'ERROR') {
          throw new Error(`HeroSMS 状态错误：${status.error || '未知'}`);
        }
        if (Date.now() + POLL_INTERVAL_MS >= deadline) break;
        await sleepWithStop(POLL_INTERVAL_MS);
      }
      return { ok: false, timedOut: true };
    }

    async function tryReuseLastActivation(apiKey, country, service) {
      if (typeof loadLastActivation !== 'function') return null;
      let last;
      try {
        last = await loadLastActivation();
      } catch (err) {
        await addLog(`步骤 8：读取上次 HeroSMS 号码失败：${err?.message || err}`, 'warn');
        return null;
      }
      if (!last || !last.activationId || !last.phone) {
        await addLog('步骤 8：未找到可复用的上次 HeroSMS 号码，将买新号。', 'info');
        return null;
      }
      if (last.country && Number(last.country) !== Number(country)) {
        await addLog(`步骤 8：上次号码所属国家 ${last.country} 与当前配置 ${country} 不一致，跳过复用。`, 'info');
        return null;
      }
      if (last.service && String(last.service) !== String(service)) {
        await addLog(`步骤 8：上次号码所属服务 ${last.service} 与当前配置 ${service} 不一致，跳过复用。`, 'info');
        return null;
      }

      await addLog(
        `步骤 8：检测到上次 HeroSMS 号码 +${last.phone}（activationId=${last.activationId}），正在调用 getStatus 验证是否仍可复用...`,
        'info'
      );
      let status;
      try {
        status = await HeroSmsUtils.getStatus(apiKey, last.activationId, httpOptions());
      } catch (err) {
        await addLog(`步骤 8：getStatus 验证上次号码失败，将买新号：${err?.message || err}`, 'warn');
        return null;
      }
      if (REUSABLE_STATUSES.has(status.status)) {
        await addLog(
          `步骤 8：上次号码 +${last.phone} 仍在激活期（getStatus=STATUS_${status.status}），复用该号码。`,
          'ok'
        );
        return { activationId: last.activationId, phone: last.phone };
      }
      await addLog(
        `步骤 8：上次号码不再可用（getStatus=${status.status}${status.error ? `:${status.error}` : ''}），将买新号。`,
        'info'
      );
      if (typeof clearLastActivation === 'function') {
        try { await clearLastActivation(); } catch (_) {}
      }
      return null;
    }

    async function requestSmsResend(apiKey, activationId) {
      try {
        await HeroSmsUtils.setStatus(
          apiKey,
          activationId,
          HeroSmsUtils.ACTIVATION_STATUS.REQUEST_RESEND,
          httpOptions()
        );
        await addLog('步骤 8：已向 HeroSMS 请求重发短信（setStatus=3）。', 'info');
      } catch (err) {
        await addLog(`步骤 8：HeroSMS setStatus=3 失败（继续尝试点击页面重发按钮）：${err?.message || err}`, 'warn');
      }
      try {
        await sendAddPhoneMessage(
          'ADD_PHONE_REQUEST_RESEND',
          {},
          ADD_PHONE_RESEND_TIMEOUT_MS,
          '步骤 8：正在请求 OpenAI 重发短信...'
        );
        await addLog('步骤 8：已点击 OpenAI 的“重新发送短信”按钮，继续等待 SMS。', 'info');
      } catch (err) {
        await addLog(`步骤 8：点击 OpenAI 重发按钮失败：${err?.message || err}`, 'warn');
      }
    }

    async function run(step, state, { url } = {}) {
      let config;
      try {
        config = HeroSmsUtils.normalizeHeroSmsConfig(await loadHeroSmsConfig());
      } catch (err) {
        await addLog(`步骤 8：读取 HeroSMS 配置失败：${err?.message || err}`, 'warn');
        return false;
      }

      if (!config.enabled) {
        return false;
      }
      if (!config.apiKey) {
        await addLog('步骤 8：HeroSMS 已启用但未填写 api_key，回退到停止当前轮。', 'warn');
        return false;
      }

      const urlSuffix = url ? `，URL: ${url}` : '';
      await addLog(
        `步骤 8：检测到 add-phone 页面${urlSuffix}，启动 HeroSMS 手机验证（国家 ${config.country} / 服务 ${config.service}${config.reuseLastActivation ? '，已启用复用' : ''}）...`,
        'info'
      );

      let activationId = null;
      let phone = null;
      let reused = false;

      if (config.reuseLastActivation) {
        const reusable = await tryReuseLastActivation(config.apiKey, config.country, config.service);
        if (reusable) {
          activationId = reusable.activationId;
          phone = reusable.phone;
          reused = true;
        }
      }

      if (!reused) {
        const maxPrice = await resolveMaxPrice(config.apiKey, config.service, config.country, config.maxPrice);

        let activation;
        try {
          activation = await HeroSmsUtils.getNumber(
            config.apiKey,
            { service: config.service, country: config.country, maxPrice },
            httpOptions()
          );

          // Retry logic: if the dynamic maxPrice we found was too low, try again with the suggested minPrice
          if (!activation.ok && activation.error === 'WRONG_MAX_PRICE' && activation.minPrice) {
            // Only auto-retry if user didn't set a strict maxPrice in the UI
            const userSetMaxPrice = Number.isFinite(Number(config.maxPrice)) && Number(config.maxPrice) > 0;
            if (!userSetMaxPrice) {
              await addLog(`步骤 8：HeroSMS 提示价格偏低，正在以建议价 ${activation.minPrice} 重新尝试购买...`, 'info');
              activation = await HeroSmsUtils.getNumber(
                config.apiKey,
                { service: config.service, country: config.country, maxPrice: activation.minPrice },
                httpOptions()
              );
            }
          }
        } catch (err) {
          await addLog(`步骤 8：HeroSMS getNumber 请求失败：${err?.message || err}`, 'warn');
          return false;
        }

        if (!activation.ok) {
          if (activation.error === 'WRONG_MAX_PRICE') {
            await addLog(
              `步骤 8：HeroSMS 当前最低价为 ${activation.minPrice || '未知'}，高于配置上限，本轮按失败处理。`,
              'warn'
            );
          } else {
            await addLog(`步骤 8：HeroSMS 获取号码失败：${activation.error}`, 'warn');
          }
          return false;
        }

        activationId = activation.activationId;
        phone = activation.phone;
        await addLog(
          `步骤 8：已获取 HeroSMS 号码 +${phone}（activationId=${activationId}）。`,
          'ok'
        );

        if (typeof saveLastActivation === 'function') {
          try {
            await saveLastActivation({
              activationId,
              phone,
              country: config.country,
              service: config.service,
              savedAt: Date.now(),
            });
          } catch (saveErr) {
            await addLog(`步骤 8：保存本次 HeroSMS 号码失败（不影响本轮流程）：${saveErr?.message || saveErr}`, 'warn');
          }
        }
      }

      const countryIso = HeroSmsUtils.resolveCountryIso
        ? HeroSmsUtils.resolveCountryIso(config.country)
        : '';

      let finished = false;
      try {
        throwIfStopped();
        await sendAddPhoneMessage(
          'ADD_PHONE_FILL_NUMBER',
          { phone, country: config.country, countryIso },
          ADD_PHONE_FILL_TIMEOUT_MS,
          '步骤 8：正在切换回认证页填写手机号...'
        );
        await addLog(`步骤 8：已将号码 +${phone} 填入 add-phone 页面。`, 'info');

        throwIfStopped();
        await sendAddPhoneMessage(
          'ADD_PHONE_SUBMIT',
          {},
          ADD_PHONE_SUBMIT_TIMEOUT_MS,
          '步骤 8：正在提交 add-phone 页面...'
        );
        await addLog('步骤 8：已提交手机号，等待 SMS 验证码...', 'info');

        try {
          await HeroSmsUtils.setStatus(
            config.apiKey,
            activationId,
            HeroSmsUtils.ACTIVATION_STATUS.SMS_SENT,
            httpOptions()
          );
          await addLog('步骤 8：已向 HeroSMS 发送 setStatus=1（号码已提交）信号。', 'info');
        } catch (err) {
          await addLog(`步骤 8：HeroSMS setStatus=1 失败（继续轮询）：${err?.message || err}`, 'warn');
        }

        let code = null;
        const firstRound = await pollSmsCode(config.apiKey, activationId, { round: 1 });
        if (firstRound.ok) {
          code = firstRound.code;
        } else {
          await addLog(`步骤 8：HeroSMS 首轮 ${Math.round(POLL_TIMEOUT_MS / 1000)} 秒内未收到短信，请求重发后继续轮询...`, 'warn');
          await requestSmsResend(config.apiKey, activationId);
          const secondRound = await pollSmsCode(config.apiKey, activationId, { round: 2 });
          if (secondRound.ok) {
            code = secondRound.code;
          } else {
            throw new Error(`HeroSMS 在两轮共 ${Math.round(POLL_TIMEOUT_MS * 2 / 1000)} 秒内未收到短信验证码。`);
          }
        }

        await addLog(`步骤 8：已收到 HeroSMS 验证码 ${code}。`, 'ok');

        throwIfStopped();
        await sendAddPhoneMessage(
          'ADD_PHONE_FILL_CODE',
          { code },
          FILL_CODE_TIMEOUT_MS,
          '步骤 8：正在填写短信验证码...'
        );

        try {
          await HeroSmsUtils.setStatus(
            config.apiKey,
            activationId,
            HeroSmsUtils.ACTIVATION_STATUS.COMPLETE,
            httpOptions()
          );
        } catch (err) {
          await addLog(`步骤 8：HeroSMS setStatus=6 失败（号码已成功使用，可忽略）：${err?.message || err}`, 'warn');
        }

        finished = true;
        await addLog('步骤 8：HeroSMS 手机验证已完成。', 'ok');
        return true;
      } catch (err) {
        await addLog(`步骤 8：HeroSMS 手机验证失败：${err?.message || err}`, 'warn');
        return false;
      } finally {
        if (!finished) {
          if (config.reuseLastActivation) {
            await addLog(
              `步骤 8：已保留 HeroSMS activation ${activationId} 供下轮复用（不取消），activation 过期前下轮可免费再试。`,
              'info'
            );
          } else {
            await safeCancelActivation(config.apiKey, activationId);
          }
        }
      }
    }

    return { run };
  }

  return { createPhoneVerifyFlow };
});
