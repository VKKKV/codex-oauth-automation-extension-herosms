(function attachBackgroundStep8(root, factory) {
  root.MultiPageBackgroundStep8 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep8Module() {
  function createStep8Executor(deps = {}) {
    const {
      addLog,
      chrome,
      cleanupStep8NavigationListeners,
      clickWithDebugger,
      completeStepFromBackground,
      ensureStep8SignupPageReady,
      getStep8CallbackUrlFromNavigation,
      getStep8CallbackUrlFromTabUpdate,
      getStep8EffectLabel,
      getTabId,
      isTabAlive,
      prepareStep8DebuggerClick,
      reloadStep8ConsentPage,
      reuseOrCreateTab,
      sleepWithStop,
      STEP8_CLICK_RETRY_DELAY_MS,
      STEP8_MAX_ROUNDS,
      STEP8_READY_WAIT_TIMEOUT_MS,
      STEP8_STRATEGIES,
      throwIfStep8SettledOrStopped,
      triggerStep8ContentStrategy,
      waitForStep8ClickEffect,
      waitForStep8Ready,
      setWebNavListener,
      setWebNavCommittedListener,
      setStep8PendingReject,
      setStep8TabUpdatedListener,
    } = deps;

    async function executeStep8(state) {
      if (!state.oauthUrl) {
        throw new Error('缺少登录用 OAuth 链接，请先完成步骤 6。');
      }

      await addLog('步骤 8：正在监听 localhost 回调地址...');

      return new Promise((resolve, reject) => {
        let resolved = false;
        let signupTabId = null;

        const cleanupListener = () => {
          cleanupStep8NavigationListeners();
          setStep8PendingReject(null);
        };

        const rejectStep8 = (error) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          cleanupListener();
          reject(error);
        };

        const finalizeStep8Callback = (callbackUrl) => {
          if (resolved || !callbackUrl) return;

          resolved = true;
          cleanupListener();
          clearTimeout(timeout);

          addLog(`步骤 8：已捕获 localhost 地址：${callbackUrl}`, 'ok').then(() => {
            return completeStepFromBackground(8, { localhostUrl: callbackUrl });
          }).then(() => {
            resolve();
          }).catch((err) => {
            reject(err);
          });
        };

        const timeout = setTimeout(() => {
          rejectStep8(new Error('120 秒内未捕获到 localhost 回调跳转，步骤 8 的点击可能被拦截了。'));
        }, 120000);

        setStep8PendingReject((error) => {
          rejectStep8(error);
        });

        setWebNavListener((details) => {
          const callbackUrl = getStep8CallbackUrlFromNavigation(details, signupTabId);
          finalizeStep8Callback(callbackUrl);
        });

        setWebNavCommittedListener((details) => {
          const callbackUrl = getStep8CallbackUrlFromNavigation(details, signupTabId);
          finalizeStep8Callback(callbackUrl);
        });

        setStep8TabUpdatedListener((tabId, changeInfo, tab) => {
          const callbackUrl = getStep8CallbackUrlFromTabUpdate(tabId, changeInfo, tab, signupTabId);
          finalizeStep8Callback(callbackUrl);
        });

        (async () => {
          try {
            throwIfStep8SettledOrStopped(resolved);
            signupTabId = await getTabId('signup-page');
            throwIfStep8SettledOrStopped(resolved);

            if (signupTabId && await isTabAlive('signup-page')) {
              await chrome.tabs.update(signupTabId, { active: true });
              await addLog('步骤 8：已切回认证页，正在准备调试器点击...');
            } else {
              signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
              await addLog('步骤 8：已重新打开认证页，正在准备调试器点击...');
            }

            throwIfStep8SettledOrStopped(resolved);
            chrome.webNavigation.onBeforeNavigate.addListener(deps.getWebNavListener());
            chrome.webNavigation.onCommitted.addListener(deps.getWebNavCommittedListener());
            chrome.tabs.onUpdated.addListener(deps.getStep8TabUpdatedListener());
            await ensureStep8SignupPageReady(signupTabId, {
              timeoutMs: 15000,
              logMessage: '步骤 8：认证页内容脚本尚未就绪，正在等待页面恢复...',
            });

            for (let round = 1; round <= STEP8_MAX_ROUNDS && !resolved; round++) {
              throwIfStep8SettledOrStopped(resolved);
              const pageState = await waitForStep8Ready(signupTabId, STEP8_READY_WAIT_TIMEOUT_MS);
              if (!pageState?.consentReady) {
                await sleepWithStop(STEP8_CLICK_RETRY_DELAY_MS);
                continue;
              }

              const strategy = STEP8_STRATEGIES[Math.min(round - 1, STEP8_STRATEGIES.length - 1)];

              await addLog(`步骤 8：第 ${round}/${STEP8_MAX_ROUNDS} 轮尝试点击“继续”（${strategy.label}）...`);

              if (strategy.mode === 'debugger') {
                const clickTarget = await prepareStep8DebuggerClick(signupTabId);
                throwIfStep8SettledOrStopped(resolved);
                await clickWithDebugger(signupTabId, clickTarget?.rect);
              } else {
                await triggerStep8ContentStrategy(signupTabId, strategy.strategy);
              }

              if (resolved) {
                return;
              }

              const effect = await waitForStep8ClickEffect(signupTabId, pageState.url);
              if (resolved) {
                return;
              }

              if (effect.progressed) {
                await addLog(`步骤 8：检测到本次点击已生效，${getStep8EffectLabel(effect)}，继续等待 localhost 回调...`, 'info');
                break;
              }

              if (effect.restartCurrentStep) {
                await addLog(`步骤 8：${getStep8EffectLabel(effect)}，准备重新定位“继续”按钮并重试...`, 'warn');
                await sleepWithStop(STEP8_CLICK_RETRY_DELAY_MS);
                continue;
              }

              if (round >= STEP8_MAX_ROUNDS) {
                throw new Error(`步骤 8：连续 ${STEP8_MAX_ROUNDS} 轮点击“继续”后页面仍无反应。`);
              }

              await addLog(`步骤 8：${strategy.label} 本轮点击后页面无反应，正在刷新认证页后重试（下一轮 ${round + 1}/${STEP8_MAX_ROUNDS}）...`, 'warn');
              await reloadStep8ConsentPage(signupTabId);
              await sleepWithStop(STEP8_CLICK_RETRY_DELAY_MS);
            }
          } catch (err) {
            rejectStep8(err);
          }
        })();
      });
    }

    return { executeStep8 };
  }

  return { createStep8Executor };
});
