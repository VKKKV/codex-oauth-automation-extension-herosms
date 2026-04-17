const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const step2Source = fs.readFileSync('background/steps/submit-signup-email.js', 'utf8');
const step2GlobalScope = {};
const step2Api = new Function('self', `${step2Source}; return self.MultiPageBackgroundStep2;`)(step2GlobalScope);

const signupFlowSource = fs.readFileSync('background/signup-flow-helpers.js', 'utf8');
const signupFlowGlobalScope = {};
const signupFlowApi = new Function('self', `${signupFlowSource}; return self.MultiPageSignupFlowHelpers;`)(signupFlowGlobalScope);

test('step 2 completes with password step skipped when landing on email verification page', async () => {
  const completedPayloads = [];

  const executor = step2Api.createStep2Executor({
    addLog: async () => {},
    chrome: { tabs: { update: async () => {} } },
    completeStepFromBackground: async (step, payload) => {
      completedPayloads.push({ step, payload });
    },
    ensureContentScriptReadyOnTab: async () => {},
    ensureSignupEntryPageReady: async () => ({ tabId: 11 }),
    ensureSignupPostEmailPageReadyInTab: async () => ({
      state: 'verification_page',
      url: 'https://auth.openai.com/email-verification',
    }),
    getTabId: async () => 11,
    isTabAlive: async () => true,
    resolveSignupEmailForFlow: async () => 'user@example.com',
    sendToContentScriptResilient: async () => ({ submitted: true }),
    SIGNUP_PAGE_INJECT_FILES: [],
  });

  await executor.executeStep2({ email: 'user@example.com' });

  assert.deepStrictEqual(completedPayloads, [
    {
      step: 2,
      payload: {
        email: 'user@example.com',
        nextSignupState: 'verification_page',
        nextSignupUrl: 'https://auth.openai.com/email-verification',
        skippedPasswordStep: true,
      },
    },
  ]);
});

test('step 2 keeps password flow when landing on password page', async () => {
  const completedPayloads = [];

  const executor = step2Api.createStep2Executor({
    addLog: async () => {},
    chrome: { tabs: { update: async () => {} } },
    completeStepFromBackground: async (step, payload) => {
      completedPayloads.push({ step, payload });
    },
    ensureContentScriptReadyOnTab: async () => {},
    ensureSignupEntryPageReady: async () => ({ tabId: 12 }),
    ensureSignupPostEmailPageReadyInTab: async () => ({
      state: 'password_page',
      url: 'https://auth.openai.com/create-account/password',
    }),
    getTabId: async () => 12,
    isTabAlive: async () => true,
    resolveSignupEmailForFlow: async () => 'user@example.com',
    sendToContentScriptResilient: async () => ({ submitted: true }),
    SIGNUP_PAGE_INJECT_FILES: [],
  });

  await executor.executeStep2({ email: 'user@example.com' });

  assert.deepStrictEqual(completedPayloads, [
    {
      step: 2,
      payload: {
        email: 'user@example.com',
        nextSignupState: 'password_page',
        nextSignupUrl: 'https://auth.openai.com/create-account/password',
        skippedPasswordStep: false,
      },
    },
  ]);
});

test('signup flow helper recognizes email verification page as post-email landing page', async () => {
  let ensureCalls = 0;
  let passwordReadyChecks = 0;

  const helpers = signupFlowApi.createSignupFlowHelpers({
    buildGeneratedAliasEmail: () => '',
    chrome: {
      tabs: {
        get: async () => ({
          id: 21,
          url: 'https://auth.openai.com/email-verification',
        }),
      },
    },
    ensureContentScriptReadyOnTab: async () => {
      ensureCalls += 1;
    },
    ensureHotmailAccountForFlow: async () => ({}),
    ensureLuckmailPurchaseForFlow: async () => ({}),
    isGeneratedAliasProvider: () => false,
    isHotmailProvider: () => false,
    isLuckmailProvider: () => false,
    isSignupEmailVerificationPageUrl: (url) => /\/email-verification(?:[/?#]|$)/i.test(url || ''),
    isSignupPasswordPageUrl: (url) => /\/create-account\/password(?:[/?#]|$)/i.test(url || ''),
    reuseOrCreateTab: async () => 21,
    sendToContentScriptResilient: async () => {
      passwordReadyChecks += 1;
      return {};
    },
    setEmailState: async () => {},
    SIGNUP_ENTRY_URL: 'https://chatgpt.com/',
    SIGNUP_PAGE_INJECT_FILES: [],
    waitForTabUrlMatch: async () => ({
      id: 21,
      url: 'https://auth.openai.com/email-verification',
    }),
  });

  const result = await helpers.ensureSignupPostEmailPageReadyInTab(21, 2);

  assert.deepStrictEqual(result, {
    ready: true,
    state: 'verification_page',
    url: 'https://auth.openai.com/email-verification',
  });
  assert.equal(ensureCalls, 1);
  assert.equal(passwordReadyChecks, 0);
});

test('signup flow helper reuses existing managed alias email when it is still compatible', async () => {
  let buildCalls = 0;
  let setEmailCalls = 0;

  const helpers = signupFlowApi.createSignupFlowHelpers({
    buildGeneratedAliasEmail: () => {
      buildCalls += 1;
      return 'demo+fresh@gmail.com';
    },
    chrome: { tabs: { get: async () => ({ id: 21, url: 'https://auth.openai.com/create-account/password' }) } },
    ensureContentScriptReadyOnTab: async () => {},
    ensureHotmailAccountForFlow: async () => ({}),
    ensureLuckmailPurchaseForFlow: async () => ({}),
    isGeneratedAliasProvider: () => true,
    isReusableGeneratedAliasEmail: (_state, email) => email === 'demo+saved@gmail.com',
    isHotmailProvider: () => false,
    isLuckmailProvider: () => false,
    isSignupEmailVerificationPageUrl: () => false,
    isSignupPasswordPageUrl: () => true,
    reuseOrCreateTab: async () => 21,
    sendToContentScriptResilient: async () => ({}),
    setEmailState: async () => {
      setEmailCalls += 1;
    },
    SIGNUP_ENTRY_URL: 'https://chatgpt.com/',
    SIGNUP_PAGE_INJECT_FILES: [],
    waitForTabUrlMatch: async () => null,
  });

  const email = await helpers.resolveSignupEmailForFlow({
    mailProvider: 'gmail',
    email: 'demo+saved@gmail.com',
  });

  assert.equal(email, 'demo+saved@gmail.com');
  assert.equal(buildCalls, 0);
  assert.equal(setEmailCalls, 0);
});
