const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HERO_SMS_BASE_URL,
  HERO_SMS_DEFAULT_COUNTRY,
  HERO_SMS_DEFAULT_SERVICE,
  DEFAULT_CONFIG,
  ACTIVATION_STATUS,
  normalizeHeroSmsConfig,
  buildHeroSmsRequestUrl,
  parseBalanceResponse,
  parseGetNumberResponse,
  parseGetStatusResponse,
  parseSetStatusResponse,
  pickLowestPrice,
  stripDialPrefix,
  resolveCountryIso,
  getBalance,
  getNumber,
  getStatus,
  setStatus,
} = require('../hero-sms-utils.js');

test('DEFAULT_CONFIG matches Thailand + OpenAI defaults', () => {
  assert.equal(DEFAULT_CONFIG.enabled, false);
  assert.equal(DEFAULT_CONFIG.apiKey, '');
  assert.equal(DEFAULT_CONFIG.country, 41);
  assert.equal(DEFAULT_CONFIG.service, 'dr');
  assert.equal(DEFAULT_CONFIG.maxPrice, '');
  assert.equal(DEFAULT_CONFIG.reuseLastActivation, false);
  assert.equal(HERO_SMS_DEFAULT_COUNTRY, 41);
  assert.equal(HERO_SMS_DEFAULT_SERVICE, 'dr');
  assert.equal(ACTIVATION_STATUS.COMPLETE, 6);
  assert.equal(ACTIVATION_STATUS.CANCEL, 8);
});

test('normalizeHeroSmsConfig trims and falls back to defaults', () => {
  assert.deepEqual(normalizeHeroSmsConfig(), {
    enabled: false,
    apiKey: '',
    country: 41,
    service: 'dr',
    maxPrice: '',
    reuseLastActivation: false,
  });

  assert.deepEqual(normalizeHeroSmsConfig({
    enabled: 1,
    apiKey: '  abc-key  ',
    country: '7',
    service: '  wa  ',
    maxPrice: '0.08',
    reuseLastActivation: 1,
  }), {
    enabled: true,
    apiKey: 'abc-key',
    country: 7,
    service: 'wa',
    maxPrice: 0.08,
    reuseLastActivation: true,
  });

  assert.deepEqual(normalizeHeroSmsConfig({
    enabled: false,
    country: -1,
    service: '',
    maxPrice: 0,
  }), {
    enabled: false,
    apiKey: '',
    country: 41,
    service: 'dr',
    maxPrice: '',
    reuseLastActivation: false,
  });
});

test('buildHeroSmsRequestUrl emits canonical query string', () => {
  const url = buildHeroSmsRequestUrl('getNumber', { service: 'ot', country: 52, maxPrice: 0.05 }, 'KEY');
  assert.ok(url.startsWith(`${HERO_SMS_BASE_URL}?`));
  assert.ok(url.includes('api_key=KEY'));
  assert.ok(url.includes('action=getNumber'));
  assert.ok(url.includes('service=ot'));
  assert.ok(url.includes('country=52'));
  assert.ok(url.includes('maxPrice=0.05'));

  const urlNoMax = buildHeroSmsRequestUrl('getStatus', { id: '100001' }, 'KEY');
  assert.ok(!urlNoMax.includes('maxPrice'));
  assert.ok(urlNoMax.includes('id=100001'));

  const urlEmptyParams = buildHeroSmsRequestUrl('getBalance', {}, 'KEY');
  assert.equal(urlEmptyParams, `${HERO_SMS_BASE_URL}?api_key=KEY&action=getBalance`);
});

test('parseBalanceResponse extracts numeric balance', () => {
  assert.deepEqual(parseBalanceResponse('ACCESS_BALANCE:100.5'), { ok: true, balance: 100.5 });
  assert.deepEqual(parseBalanceResponse('ACCESS_BALANCE:0'), { ok: true, balance: 0 });
  assert.deepEqual(parseBalanceResponse('BAD_KEY'), { ok: false, error: 'BAD_KEY' });
  assert.deepEqual(parseBalanceResponse(''), { ok: false, error: 'UNKNOWN' });
});

test('parseGetNumberResponse handles success and errors', () => {
  assert.deepEqual(
    parseGetNumberResponse('ACCESS_NUMBER:123456789:66812345678'),
    { ok: true, activationId: '123456789', phone: '66812345678' }
  );
  assert.deepEqual(parseGetNumberResponse('NO_NUMBERS'), { ok: false, error: 'NO_NUMBERS' });
  assert.deepEqual(
    parseGetNumberResponse('WRONG_MAX_PRICE:0.0712'),
    { ok: false, error: 'WRONG_MAX_PRICE', minPrice: 0.0712 }
  );
  assert.deepEqual(parseGetNumberResponse('NO_BALANCE'), { ok: false, error: 'NO_BALANCE' });
  assert.deepEqual(parseGetNumberResponse('BAD_KEY'), { ok: false, error: 'BAD_KEY' });
  const banned = parseGetNumberResponse('BANNED:2026-04-20');
  assert.equal(banned.ok, false);
  assert.equal(banned.error, 'BANNED');
  assert.equal(banned.raw, 'BANNED:2026-04-20');
});

test('parseGetStatusResponse discriminates polling states', () => {
  assert.deepEqual(parseGetStatusResponse('STATUS_WAIT_CODE'), { status: 'WAIT_CODE' });
  assert.deepEqual(parseGetStatusResponse('STATUS_WAIT_RESEND'), { status: 'WAIT_RESEND' });
  assert.deepEqual(parseGetStatusResponse('STATUS_WAIT_RETRY:98765'), { status: 'WAIT_RETRY', code: '98765' });
  assert.deepEqual(parseGetStatusResponse('STATUS_CANCEL'), { status: 'CANCEL' });
  assert.deepEqual(parseGetStatusResponse('STATUS_OK:052645'), { status: 'OK', code: '052645' });
  const err = parseGetStatusResponse('NO_ACTIVATION');
  assert.equal(err.status, 'ERROR');
  assert.equal(err.error, 'NO_ACTIVATION');
});

test('parseSetStatusResponse maps ACCESS_* results', () => {
  assert.deepEqual(parseSetStatusResponse('ACCESS_READY'), { ok: true, result: 'READY' });
  assert.deepEqual(parseSetStatusResponse('ACCESS_RETRY_GET'), { ok: true, result: 'RETRY_GET' });
  assert.deepEqual(parseSetStatusResponse('ACCESS_ACTIVATION'), { ok: true, result: 'ACTIVATION' });
  assert.deepEqual(parseSetStatusResponse('ACCESS_CANCEL'), { ok: true, result: 'CANCEL' });
  assert.deepEqual(parseSetStatusResponse('EARLY_CANCEL_DENIED'), { ok: false, error: 'EARLY_CANCEL_DENIED' });
  assert.deepEqual(parseSetStatusResponse('BAD_STATUS'), { ok: false, error: 'BAD_STATUS' });
});

test('pickLowestPrice navigates both nested shapes and skips empty entries', () => {
  const nested = {
    52: {
      ot: { cost: 0.05, count: 120 },
      wa: { cost: 0.07, count: 200 },
    },
    6: {
      ot: { cost: 0.04, count: 300 },
    },
  };
  assert.equal(pickLowestPrice(nested, { service: 'ot', country: 52 }), 0.05);

  const flat = {
    ot: { cost: 0.045, count: 50 },
  };
  assert.equal(pickLowestPrice(flat, { service: 'ot', country: 52 }), 0.045);

  const zeroCount = {
    52: { ot: { cost: 0.05, count: 0 } },
  };
  assert.equal(pickLowestPrice(zeroCount, { service: 'ot', country: 52 }), null);

  assert.equal(pickLowestPrice(null, { service: 'ot', country: 52 }), null);
  assert.equal(pickLowestPrice({}, { service: 'ot', country: 52 }), null);
  assert.equal(pickLowestPrice({ 52: { ot: {} } }, { service: 'ot', country: 52 }), null);
});

test('resolveCountryIso maps IDs to codes', () => {
  assert.equal(resolveCountryIso(52), 'TH');
  assert.equal(resolveCountryIso(6), 'ID');
  assert.equal(resolveCountryIso(41), 'CM');
  assert.equal(resolveCountryIso(0), '');
  assert.equal(resolveCountryIso(null), '');
});

test('stripDialPrefix drops prefixes for TH, ID, and CM', () => {
  assert.equal(stripDialPrefix('66812345678', { country: 52 }), '812345678');
  assert.equal(stripDialPrefix('+66 812-345-678', { country: 52 }), '812345678');
  assert.equal(stripDialPrefix('628123456789', { country: 6 }), '8123456789');
  assert.equal(stripDialPrefix('237658956620', { country: 41 }), '658956620');
  assert.equal(stripDialPrefix('812345678', { country: 52 }), '812345678');
  assert.equal(stripDialPrefix('1234567890', { country: 0 }), '1234567890');
  assert.equal(stripDialPrefix('', { country: 52 }), '');
});

function makeFakeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body = '', contentType = 'text/plain' } = responder(url, init) || {};
    return {
      status,
      statusText: 'OK',
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => body,
      ok: status < 400,
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('getBalance issues GET with apiKey and parses ACCESS_BALANCE', async () => {
  const fetchImpl = makeFakeFetch(() => ({ body: 'ACCESS_BALANCE:42.1' }));
  const result = await getBalance('MY_KEY', { fetchImpl });
  assert.deepEqual(result, { ok: true, balance: 42.1 });
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0].url.includes('api_key=MY_KEY'));
  assert.ok(fetchImpl.calls[0].url.includes('action=getBalance'));
});

test('getNumber passes maxPrice and parses success', async () => {
  const fetchImpl = makeFakeFetch(() => ({ body: 'ACCESS_NUMBER:321654987:66812345678' }));
  const result = await getNumber('K', { service: 'ot', country: 52, maxPrice: 0.05 }, { fetchImpl });
  assert.deepEqual(result, { ok: true, activationId: '321654987', phone: '66812345678' });
  const requestUrl = fetchImpl.calls[0].url;
  assert.ok(requestUrl.includes('service=ot'));
  assert.ok(requestUrl.includes('country=52'));
  assert.ok(requestUrl.includes('maxPrice=0.05'));
});

test('getStatus and setStatus wire through to parsers', async () => {
  const fetchImpl = makeFakeFetch((url) => {
    if (url.includes('action=getStatus')) return { body: 'STATUS_OK:654321' };
    if (url.includes('action=setStatus')) return { body: 'ACCESS_ACTIVATION' };
    return { body: 'BAD_ACTION' };
  });
  const status = await getStatus('K', '111', { fetchImpl });
  assert.deepEqual(status, { status: 'OK', code: '654321' });

  const settled = await setStatus('K', '111', 6, { fetchImpl });
  assert.deepEqual(settled, { ok: true, result: 'ACTIVATION' });
});

test('HTTP non-200 throws with status metadata', async () => {
  const fetchImpl = makeFakeFetch(() => ({ status: 401, body: 'BAD_KEY' }));
  await assert.rejects(
    () => getBalance('K', { fetchImpl }),
    (err) => err.status === 401 && /HeroSMS HTTP 401/.test(err.message)
  );
});

test('missing apiKey rejects before fetch', async () => {
  const fetchImpl = makeFakeFetch(() => ({ body: '' }));
  await assert.rejects(() => getBalance('', { fetchImpl }), /缺少 api_key/);
  assert.equal(fetchImpl.calls.length, 0);
});
