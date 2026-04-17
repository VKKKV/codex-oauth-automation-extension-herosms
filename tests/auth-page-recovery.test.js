const test = require('node:test');
const assert = require('node:assert/strict');

const { createAuthPageRecovery } = require('../content/auth-page-recovery.js');

function createRetryButton() {
  return {
    disabled: false,
    textContent: 'Try again',
    getAttribute(name) {
      if (name === 'data-dd-action-name') return 'Try again';
      if (name === 'aria-disabled') return 'false';
      return '';
    },
  };
}

function createRecoveryApi(state) {
  const retryButton = createRetryButton();
  global.location = {
    pathname: '/log-in',
    href: 'https://auth.openai.com/log-in',
  };
  global.document = {
    title: 'Something went wrong',
    querySelector(selector) {
      if (selector === 'button[data-dd-action-name="Try again"]' && state.retryVisible) {
        return retryButton;
      }
      return null;
    },
    querySelectorAll() {
      return state.retryVisible ? [retryButton] : [];
    },
  };

  return createAuthPageRecovery({
    detailPattern: /timed out/i,
    getActionText: (element) => element?.textContent || '',
    getPageTextSnapshot: () => state.pageText,
    humanPause: async () => {},
    isActionEnabled: (element) => Boolean(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true',
    isVisibleElement: () => true,
    log: () => {},
    simulateClick: () => {
      state.clickCount += 1;
      state.retryVisible = false;
      state.pageText = 'Recovered login form';
    },
    sleep: async () => {},
    throwIfStopped: () => {},
    titlePattern: /something went wrong/i,
  });
}

test('auth page recovery detects retry page state', () => {
  const state = {
    clickCount: 0,
    pageText: 'Something went wrong. Operation timed out.',
    retryVisible: true,
  };
  const api = createRecoveryApi(state);

  const snapshot = api.getAuthTimeoutErrorPageState({
    pathPatterns: [/\/log-in(?:[/?#]|$)/i],
  });

  assert.equal(Boolean(snapshot), true);
  assert.equal(snapshot.retryEnabled, true);
  assert.equal(snapshot.titleMatched, true);
  assert.equal(snapshot.detailMatched, true);
});

test('auth page recovery clicks retry and waits until page recovers', async () => {
  const state = {
    clickCount: 0,
    pageText: 'Something went wrong. Operation timed out.',
    retryVisible: true,
  };
  const api = createRecoveryApi(state);

  const result = await api.recoverAuthRetryPage({
    logLabel: '步骤 8：检测到重试页，正在点击“重试”恢复',
    pathPatterns: [/\/log-in(?:[/?#]|$)/i],
    step: 8,
    timeoutMs: 1000,
  });

  assert.deepStrictEqual(result, {
    recovered: true,
    clickCount: 1,
    url: 'https://auth.openai.com/log-in',
  });
  assert.equal(state.clickCount, 1);
  assert.equal(state.retryVisible, false);
});
