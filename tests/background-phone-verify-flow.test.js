const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const HeroSmsUtils = require('../hero-sms-utils.js');

function loadPhoneVerifyFlow() {
  const source = fs.readFileSync('background/phone-verify-flow.js', 'utf8');
  const globalScope = {};
  new Function('self', `${source}`)(globalScope);
  return globalScope.MultiPagePhoneVerifyFlow;
}

function createTestHarness(overrides = {}) {
  const logs = [];
  const sent = [];
  const sleeps = [];
  const savedActivations = [];
  const clearCalls = [];

  const defaults = {
    addLog: async (message, level = 'info') => { logs.push({ message, level }); },
    HeroSmsUtils,
    loadHeroSmsConfig: async () => ({
      enabled: true,
      apiKey: 'KEY',
      country: 52,
      service: 'ot',
      maxPrice: '',
    }),
    loadLastActivation: async () => null,
    saveLastActivation: async (activation) => { savedActivations.push(activation); },
    clearLastActivation: async () => { clearCalls.push(Date.now()); },
    sendToContentScriptResilient: async (source, message) => {
      sent.push({ source, type: message.type, payload: message.payload });
      return { ok: true };
    },
    sleepWithStop: async (ms) => { sleeps.push(ms); },
    throwIfStopped: () => {},
    fetchImpl: async () => ({
      status: 200,
      text: async () => '',
      ok: true,
    }),
  };

  const deps = { ...defaults, ...overrides };
  return { deps, logs, sent, sleeps, savedActivations, clearCalls };
}

function makeFetchScript(script) {
  const queue = script.slice();
  return async (url) => {
    const matchers = queue;
    for (let i = 0; i < matchers.length; i += 1) {
      const entry = matchers[i];
      if (entry.match(url)) {
        const response = typeof entry.body === 'function' ? entry.body(url) : entry.body;
        if (entry.once) {
          matchers.splice(i, 1);
        }
        return {
          status: entry.status || 200,
          ok: (entry.status || 200) < 400,
          text: async () => response,
        };
      }
    }
    throw new Error(`no fetch mock matched: ${url}`);
  };
}

test('returns false when config disabled', async () => {
  const { MultiPagePhoneVerifyFlow } = { MultiPagePhoneVerifyFlow: loadPhoneVerifyFlow() };
  const { deps, logs } = createTestHarness({
    loadHeroSmsConfig: async () => ({ enabled: false, apiKey: 'KEY' }),
  });
  const flow = MultiPagePhoneVerifyFlow.createPhoneVerifyFlow(deps);
  const result = await flow.run(8, {}, { url: 'https://auth.openai.com/add-phone' });
  assert.equal(result, false);
  assert.equal(logs.length, 0, 'disabled path should stay silent');
});

test('returns false when api_key missing but warns', async () => {
  const MultiPagePhoneVerifyFlow = loadPhoneVerifyFlow();
  const { deps, logs } = createTestHarness({
    loadHeroSmsConfig: async () => ({ enabled: true, apiKey: '' }),
  });
  const flow = MultiPagePhoneVerifyFlow.createPhoneVerifyFlow(deps);
  const result = await flow.run(8, {}, {});
  assert.equal(result, false);
  assert.ok(logs.some((entry) => /未填写 api_key/.test(entry.message)));
});

test('happy path: getPrices → getNumber → fill → submit → setStatus=1 → poll → code → setStatus=6', async () => {
  const MultiPagePhoneVerifyFlow = loadPhoneVerifyFlow();
  let statusCallCount = 0;
  const setStatusCalls = [];
  const fetchImpl = makeFetchScript([
    {
      match: (url) => url.includes('action=getPrices'),
      body: JSON.stringify({ 52: { ot: { cost: 0.05, count: 100 } } }),
    },
    {
      match: (url) => url.includes('action=getNumber'),
      body: (url) => {
        assert.ok(url.includes('maxPrice=0.05'));
        return 'ACCESS_NUMBER:321654987:66812345678';
      },
    },
    {
      match: (url) => url.includes('action=getStatus'),
      body: () => {
        statusCallCount += 1;
        return statusCallCount < 3 ? 'STATUS_WAIT_CODE' : 'STATUS_OK:052645';
      },
    },
    {
      match: (url) => url.includes('action=setStatus'),
      body: (url) => {
        const params = new URL(url).searchParams;
        setStatusCalls.push({ id: params.get('id'), status: params.get('status') });
        return 'ACCESS_ACTIVATION';
      },
    },
  ]);

  const { deps, sent, sleeps, logs, savedActivations } = createTestHarness({ fetchImpl });
  const flow = MultiPagePhoneVerifyFlow.createPhoneVerifyFlow(deps);
  const result = await flow.run(8, {}, { url: 'https://auth.openai.com/add-phone' });

  assert.equal(result, true, 'happy path should return true');
  assert.deepEqual(
    sent.map((entry) => entry.type),
    ['ADD_PHONE_FILL_NUMBER', 'ADD_PHONE_SUBMIT', 'ADD_PHONE_FILL_CODE'],
    'no resend needed when first round finds code'
  );
  assert.equal(sent[0].payload.phone, '66812345678');
  assert.equal(sent[0].payload.country, 52);
  assert.equal(sent[0].payload.countryIso, 'TH');
  assert.equal(sent[2].payload.code, '052645');
  assert.deepEqual(setStatusCalls, [
    { id: '321654987', status: '1' },
    { id: '321654987', status: '6' },
  ]);
  assert.equal(savedActivations.length, 1, 'getNumber success should persist lastActivation');
  assert.equal(savedActivations[0].activationId, '321654987');
  assert.equal(savedActivations[0].phone, '66812345678');
  assert.equal(savedActivations[0].country, 52);
  assert.equal(savedActivations[0].service, 'ot');
  assert.ok(sleeps.length >= 2, 'polling sleeps between getStatus calls');
  assert.ok(logs.some((entry) => /setStatus=1/.test(entry.message)));
  assert.ok(logs.some((entry) => /已获取 HeroSMS 号码/.test(entry.message)));
  assert.ok(logs.some((entry) => /已收到 HeroSMS 验证码/.test(entry.message)));
});

test('WRONG_MAX_PRICE returns false and does not call setStatus', async () => {
  const MultiPagePhoneVerifyFlow = loadPhoneVerifyFlow();
  const setStatusCalls = [];
  const fetchImpl = makeFetchScript([
    {
      match: (url) => url.includes('action=getNumber'),
      body: 'WRONG_MAX_PRICE:0.07',
    },
    {
      match: (url) => url.includes('action=setStatus'),
      body: (url) => {
        setStatusCalls.push(url);
        return 'ACCESS_CANCEL';
      },
    },
  ]);

  const { deps } = createTestHarness({
    fetchImpl,
    loadHeroSmsConfig: async () => ({
      enabled: true,
      apiKey: 'KEY',
      country: 52,
      service: 'ot',
      maxPrice: 0.03,
    }),
  });
  const flow = MultiPagePhoneVerifyFlow.createPhoneVerifyFlow(deps);
  const result = await flow.run(8, {}, {});

  assert.equal(result, false);
  assert.deepEqual(setStatusCalls, [], 'no setStatus call when getNumber fails (no activation to cancel)');
});

test('SMS polling timeout triggers resend then cancel=8 and returns false', async () => {
  const MultiPagePhoneVerifyFlow = loadPhoneVerifyFlow();
  const setStatusCalls = [];
  const fetchImpl = makeFetchScript([
    {
      match: (url) => url.includes('action=getNumber'),
      body: 'ACCESS_NUMBER:111:66900000000',
    },
    {
      match: (url) => url.includes('action=getStatus'),
      body: 'STATUS_WAIT_CODE',
    },
    {
      match: (url) => url.includes('action=setStatus'),
      body: (url) => {
        const params = new URL(url).searchParams;
        setStatusCalls.push({ id: params.get('id'), status: params.get('status') });
        return 'ACCESS_CANCEL';
      },
    },
  ]);

  const originalNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  try {
    const { deps, sent, logs } = createTestHarness({
      fetchImpl,
      sleepWithStop: async (ms) => { clock += ms; },
      loadHeroSmsConfig: async () => ({
        enabled: true,
        apiKey: 'KEY',
        country: 52,
        service: 'ot',
        maxPrice: 0.05,
      }),
    });
    const flow = MultiPagePhoneVerifyFlow.createPhoneVerifyFlow(deps);
    const result = await flow.run(8, {}, {});
    assert.equal(result, false);
    assert.deepEqual(setStatusCalls, [
      { id: '111', status: '1' },
      { id: '111', status: '3' },
      { id: '111', status: '8' },
    ]);
    assert.deepEqual(
      sent.map((entry) => entry.type),
      ['ADD_PHONE_FILL_NUMBER', 'ADD_PHONE_SUBMIT', 'ADD_PHONE_REQUEST_RESEND'],
      'resend is attempted between polling rounds'
    );
    assert.ok(logs.some((entry) => /首轮/.test(entry.message) && /未收到/.test(entry.message)));
    assert.ok(logs.some((entry) => /HeroSMS 手机验证失败/.test(entry.message)));
  } finally {
    Date.now = originalNow;
  }
});

test('second poll succeeds after resend yields STATUS_OK', async () => {
  const MultiPagePhoneVerifyFlow = loadPhoneVerifyFlow();
  const setStatusCalls = [];
  let getStatusCount = 0;
  const fetchImpl = makeFetchScript([
    {
      match: (url) => url.includes('action=getNumber'),
      body: 'ACCESS_NUMBER:555:66911111111',
    },
    {
      match: (url) => url.includes('action=setStatus'),
      body: (url) => {
        const params = new URL(url).searchParams;
        setStatusCalls.push({ id: params.get('id'), status: params.get('status') });
        return 'ACCESS_ACTIVATION';
      },
    },
    {
      match: (url) => url.includes('action=getStatus'),
      body: () => {
        getStatusCount += 1;
        if (getStatusCount > 50) return 'STATUS_OK:987654';
        return 'STATUS_WAIT_CODE';
      },
    },
  ]);

  const originalNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  try {
    const { deps, sent, logs } = createTestHarness({
      fetchImpl,
      sleepWithStop: async (ms) => { clock += ms; },
      loadHeroSmsConfig: async () => ({
        enabled: true,
        apiKey: 'KEY',
        country: 52,
        service: 'ot',
        maxPrice: 0.05,
      }),
    });
    const flow = MultiPagePhoneVerifyFlow.createPhoneVerifyFlow(deps);
    const result = await flow.run(8, {}, {});
    assert.equal(result, true);
    assert.deepEqual(
      setStatusCalls.map((c) => c.status),
      ['1', '3', '6'],
      'SMS_SENT → REQUEST_RESEND → COMPLETE'
    );
    assert.ok(sent.some((entry) => entry.type === 'ADD_PHONE_REQUEST_RESEND'));
    assert.ok(sent.some((entry) => entry.type === 'ADD_PHONE_FILL_CODE' && entry.payload.code === '987654'));
    assert.ok(logs.some((entry) => /首轮/.test(entry.message)));
  } finally {
    Date.now = originalNow;
  }
});

test('content-script error during fill causes cancel=8', async () => {
  const MultiPagePhoneVerifyFlow = loadPhoneVerifyFlow();
  const setStatusCalls = [];
  const fetchImpl = makeFetchScript([
    {
      match: (url) => url.includes('action=getNumber'),
      body: 'ACCESS_NUMBER:222:66900000001',
    },
    {
      match: (url) => url.includes('action=setStatus'),
      body: (url) => {
        const params = new URL(url).searchParams;
        setStatusCalls.push({ id: params.get('id'), status: params.get('status') });
        return 'ACCESS_CANCEL';
      },
    },
  ]);

  const { deps } = createTestHarness({
    fetchImpl,
    sendToContentScriptResilient: async () => ({ error: '认证页未找到手机号输入框' }),
    loadHeroSmsConfig: async () => ({
      enabled: true,
      apiKey: 'KEY',
      country: 52,
      service: 'ot',
      maxPrice: 0.05,
    }),
  });

  const flow = MultiPagePhoneVerifyFlow.createPhoneVerifyFlow(deps);
  const result = await flow.run(8, {}, {});
  assert.equal(result, false);
  assert.deepEqual(setStatusCalls, [{ id: '222', status: '8' }]);
});

test('dynamic price path falls back to pickLowestPrice when maxPrice empty', async () => {
  const MultiPagePhoneVerifyFlow = loadPhoneVerifyFlow();
  let seenMaxPrice = null;
  const fetchImpl = makeFetchScript([
    {
      match: (url) => url.includes('action=getPrices'),
      body: JSON.stringify({ 52: { ot: { cost: 0.042, count: 99 } } }),
    },
    {
      match: (url) => url.includes('action=getNumber'),
      body: (url) => {
        const params = new URL(url).searchParams;
        seenMaxPrice = params.get('maxPrice');
        return 'NO_NUMBERS';
      },
    },
  ]);

  const { deps } = createTestHarness({
    fetchImpl,
    loadHeroSmsConfig: async () => ({
      enabled: true,
      apiKey: 'KEY',
      country: 52,
      service: 'ot',
      maxPrice: '',
    }),
  });

  const flow = MultiPagePhoneVerifyFlow.createPhoneVerifyFlow(deps);
  const result = await flow.run(8, {}, {});
  assert.equal(result, false);
  assert.equal(seenMaxPrice, '0.042', 'dynamic lowest price passed to getNumber');
});

test('reuse: WAIT_CODE activation is reused and getNumber is skipped', async () => {
  const MultiPagePhoneVerifyFlow = loadPhoneVerifyFlow();
  const setStatusCalls = [];
  let getStatusCount = 0;
  let getNumberCalled = false;
  const fetchImpl = makeFetchScript([
    {
      match: (url) => url.includes('action=getStatus'),
      body: () => {
        getStatusCount += 1;
        if (getStatusCount === 1) return 'STATUS_WAIT_CODE';
        return getStatusCount < 3 ? 'STATUS_WAIT_CODE' : 'STATUS_OK:778899';
      },
    },
    {
      match: (url) => url.includes('action=getNumber'),
      body: () => { getNumberCalled = true; return 'ACCESS_NUMBER:NEW:66999999999'; },
    },
    {
      match: (url) => url.includes('action=setStatus'),
      body: (url) => {
        const params = new URL(url).searchParams;
        setStatusCalls.push({ id: params.get('id'), status: params.get('status') });
        return 'ACCESS_ACTIVATION';
      },
    },
    {
      match: (url) => url.includes('action=getPrices'),
      body: JSON.stringify({ 52: { dr: { cost: 0.05, count: 100 } } }),
    },
  ]);

  const { deps, sent, logs, savedActivations } = createTestHarness({
    fetchImpl,
    loadHeroSmsConfig: async () => ({
      enabled: true,
      apiKey: 'KEY',
      country: 52,
      service: 'dr',
      maxPrice: 0.05,
      reuseLastActivation: true,
    }),
    loadLastActivation: async () => ({
      activationId: 'OLD',
      phone: '66800000000',
      country: 52,
      service: 'dr',
    }),
  });

  const flow = MultiPagePhoneVerifyFlow.createPhoneVerifyFlow(deps);
  const result = await flow.run(8, {}, { url: 'https://auth.openai.com/add-phone' });

  assert.equal(result, true);
  assert.equal(getNumberCalled, false, 'getNumber should NOT be called when reusing');
  assert.equal(savedActivations.length, 0, 'no new activation saved when reusing');
  assert.equal(sent[0].payload.phone, '66800000000', 'reused phone is filled');
  assert.ok(setStatusCalls.find((c) => c.id === 'OLD' && c.status === '1'));
  assert.ok(setStatusCalls.find((c) => c.id === 'OLD' && c.status === '6'));
  assert.ok(logs.some((entry) => /复用该号码/.test(entry.message)));
});

test('reuse: getStatus OK means activation already consumed, fallback to getNumber', async () => {
  const MultiPagePhoneVerifyFlow = loadPhoneVerifyFlow();
  let getStatusCount = 0;
  const clearCalls = [];
  const fetchImpl = makeFetchScript([
    {
      match: (url) => url.includes('action=getPrices'),
      body: JSON.stringify({ 52: { dr: { cost: 0.05, count: 100 } } }),
    },
    {
      match: (url) => url.includes('action=getStatus'),
      body: () => {
        getStatusCount += 1;
        if (getStatusCount === 1) return 'STATUS_OK:111111';
        return getStatusCount < 4 ? 'STATUS_WAIT_CODE' : 'STATUS_OK:222222';
      },
    },
    {
      match: (url) => url.includes('action=getNumber'),
      body: 'ACCESS_NUMBER:FRESH:66701010101',
    },
    {
      match: (url) => url.includes('action=setStatus'),
      body: 'ACCESS_ACTIVATION',
    },
  ]);

  const { deps, sent, savedActivations, logs } = createTestHarness({
    fetchImpl,
    loadHeroSmsConfig: async () => ({
      enabled: true,
      apiKey: 'KEY',
      country: 52,
      service: 'dr',
      maxPrice: 0.05,
      reuseLastActivation: true,
    }),
    loadLastActivation: async () => ({
      activationId: 'STALE',
      phone: '66800000000',
      country: 52,
      service: 'dr',
    }),
    clearLastActivation: async () => { clearCalls.push('cleared'); },
  });

  const flow = MultiPagePhoneVerifyFlow.createPhoneVerifyFlow(deps);
  const result = await flow.run(8, {}, {});

  assert.equal(result, true);
  assert.equal(sent[0].payload.phone, '66701010101', 'fresh number used after stale failed reuse');
  assert.equal(savedActivations.length, 1);
  assert.equal(savedActivations[0].activationId, 'FRESH');
  assert.deepEqual(clearCalls, ['cleared'], 'stale activation is cleared when not reusable');
  assert.ok(logs.some((entry) => /不再可用/.test(entry.message)));
});

test('reuse: country mismatch skips reuse even if activation exists', async () => {
  const MultiPagePhoneVerifyFlow = loadPhoneVerifyFlow();
  let getNumberCalled = false;
  const fetchImpl = makeFetchScript([
    {
      match: (url) => url.includes('action=getPrices'),
      body: JSON.stringify({ 52: { dr: { cost: 0.05, count: 100 } } }),
    },
    {
      match: (url) => url.includes('action=getNumber'),
      body: () => { getNumberCalled = true; return 'ACCESS_NUMBER:NEW:66900000000'; },
    },
    {
      match: (url) => url.includes('action=getStatus'),
      body: 'STATUS_OK:333333',
    },
    {
      match: (url) => url.includes('action=setStatus'),
      body: 'ACCESS_ACTIVATION',
    },
  ]);

  const { deps, logs } = createTestHarness({
    fetchImpl,
    loadHeroSmsConfig: async () => ({
      enabled: true,
      apiKey: 'KEY',
      country: 52,
      service: 'dr',
      maxPrice: 0.05,
      reuseLastActivation: true,
    }),
    loadLastActivation: async () => ({
      activationId: 'OTHER',
      phone: '155555555',
      country: 1,
      service: 'dr',
    }),
  });

  const flow = MultiPagePhoneVerifyFlow.createPhoneVerifyFlow(deps);
  await flow.run(8, {}, {});
  assert.equal(getNumberCalled, true, 'country mismatch should force getNumber');
  assert.ok(logs.some((entry) => /国家 1 与当前配置 52 不一致/.test(entry.message)));
});

test('reuse disabled: always calls getNumber even if lastActivation exists', async () => {
  const MultiPagePhoneVerifyFlow = loadPhoneVerifyFlow();
  let getNumberCalled = false;
  let getStatusCallCount = 0;
  const fetchImpl = makeFetchScript([
    {
      match: (url) => url.includes('action=getPrices'),
      body: JSON.stringify({ 52: { dr: { cost: 0.05, count: 100 } } }),
    },
    {
      match: (url) => url.includes('action=getNumber'),
      body: () => { getNumberCalled = true; return 'ACCESS_NUMBER:NEW:66900000000'; },
    },
    {
      match: (url) => url.includes('action=getStatus'),
      body: () => { getStatusCallCount += 1; return getStatusCallCount < 2 ? 'STATUS_WAIT_CODE' : 'STATUS_OK:444444'; },
    },
    {
      match: (url) => url.includes('action=setStatus'),
      body: 'ACCESS_ACTIVATION',
    },
  ]);

  const { deps } = createTestHarness({
    fetchImpl,
    loadHeroSmsConfig: async () => ({
      enabled: true,
      apiKey: 'KEY',
      country: 52,
      service: 'dr',
      maxPrice: 0.05,
      reuseLastActivation: false,
    }),
    loadLastActivation: async () => ({
      activationId: 'ALIVE_BUT_IGNORED',
      phone: '66700000000',
      country: 52,
      service: 'dr',
    }),
  });

  const flow = MultiPagePhoneVerifyFlow.createPhoneVerifyFlow(deps);
  await flow.run(8, {}, {});
  assert.equal(getNumberCalled, true, 'reuse=false should call getNumber even with alive activation');
});

test('reuse=true preserves activation on timeout (no setStatus=8) so next round can reuse', async () => {
  const MultiPagePhoneVerifyFlow = loadPhoneVerifyFlow();
  const setStatusCalls = [];
  const fetchImpl = makeFetchScript([
    {
      match: (url) => url.includes('action=getNumber'),
      body: 'ACCESS_NUMBER:PRESERVED:66800000000',
    },
    {
      match: (url) => url.includes('action=getStatus'),
      body: 'STATUS_WAIT_CODE',
    },
    {
      match: (url) => url.includes('action=setStatus'),
      body: (url) => {
        const params = new URL(url).searchParams;
        setStatusCalls.push({ id: params.get('id'), status: params.get('status') });
        return 'ACCESS_ACTIVATION';
      },
    },
  ]);

  const originalNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  try {
    const { deps, logs } = createTestHarness({
      fetchImpl,
      sleepWithStop: async (ms) => { clock += ms; },
      loadHeroSmsConfig: async () => ({
        enabled: true,
        apiKey: 'KEY',
        country: 52,
        service: 'dr',
        maxPrice: 0.05,
        reuseLastActivation: true,
      }),
    });
    const flow = MultiPagePhoneVerifyFlow.createPhoneVerifyFlow(deps);
    const result = await flow.run(8, {}, {});
    assert.equal(result, false);
    assert.deepEqual(
      setStatusCalls.map((c) => c.status),
      ['1', '3'],
      'reuse=true: only SMS_SENT + REQUEST_RESEND, NO setStatus=8 cancel'
    );
    assert.ok(logs.some((entry) => /保留 HeroSMS activation/.test(entry.message)));
  } finally {
    Date.now = originalNow;
  }
});
