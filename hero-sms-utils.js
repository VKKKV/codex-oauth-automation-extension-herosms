(function heroSmsUtilsModule(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }

  root.HeroSmsUtils = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createHeroSmsUtils() {
  const HERO_SMS_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';
  const HERO_SMS_DEFAULT_COUNTRY = 16;
  const HERO_SMS_DEFAULT_SERVICE = 'dr';
  const HERO_SMS_DEFAULT_POLL_INTERVAL_MS = 5000;
  const HERO_SMS_DEFAULT_POLL_TIMEOUT_MS = 180000;

  const ACTIVATION_STATUS = Object.freeze({
    SMS_SENT: 1,
    REQUEST_RESEND: 3,
    COMPLETE: 6,
    CANCEL: 8,
  });

  const DEFAULT_CONFIG = Object.freeze({
    enabled: false,
    apiKey: '',
    country: HERO_SMS_DEFAULT_COUNTRY,
    service: HERO_SMS_DEFAULT_SERVICE,
    maxPrice: '',
    reuseLastActivation: false,
  });

  function normalizeHeroSmsConfig(config = {}) {
    const source = config && typeof config === 'object' ? config : {};
    const rawApiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';
    const rawCountry = Number(source.country);
    const rawService = typeof source.service === 'string' ? source.service.trim() : '';
    const rawMaxPrice = source.maxPrice;
    let maxPrice = '';
    if (rawMaxPrice !== '' && rawMaxPrice !== null && rawMaxPrice !== undefined) {
      const parsed = Number(rawMaxPrice);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxPrice = parsed;
      }
    }
    return {
      enabled: Boolean(source.enabled),
      apiKey: rawApiKey,
      country: Number.isFinite(rawCountry) && rawCountry > 0 ? rawCountry : HERO_SMS_DEFAULT_COUNTRY,
      service: rawService || HERO_SMS_DEFAULT_SERVICE,
      maxPrice,
      reuseLastActivation: Boolean(source.reuseLastActivation),
    };
  }

  function buildHeroSmsRequestUrl(action, params = {}, apiKey = '') {
    const query = new URLSearchParams();
    if (apiKey) {
      query.set('api_key', apiKey);
    }
    query.set('action', action);
    for (const [key, value] of Object.entries(params || {})) {
      if (value === null || value === undefined || value === '') continue;
      query.set(key, String(value));
    }
    return `${HERO_SMS_BASE_URL}?${query.toString()}`;
  }

  function parseBalanceResponse(text) {
    const raw = String(text == null ? '' : text).trim();
    const match = /^ACCESS_BALANCE:([0-9]+(?:\.[0-9]+)?)/i.exec(raw);
    if (match) {
      return { ok: true, balance: Number(match[1]) };
    }
    return { ok: false, error: raw || 'UNKNOWN' };
  }

  function parseGetNumberResponse(text) {
    const raw = String(text == null ? '' : text).trim();
    const accessMatch = /^ACCESS_NUMBER:([^:]+):(.+)$/i.exec(raw);
    if (accessMatch) {
      return { ok: true, activationId: accessMatch[1].trim(), phone: accessMatch[2].trim() };
    }
    if (/^NO_NUMBERS$/i.test(raw)) {
      return { ok: false, error: 'NO_NUMBERS' };
    }
    const wrongMax = /^WRONG_MAX_PRICE:([0-9]+(?:\.[0-9]+)?)/i.exec(raw);
    if (wrongMax) {
      return { ok: false, error: 'WRONG_MAX_PRICE', minPrice: Number(wrongMax[1]) };
    }
    if (/^NO_BALANCE$/i.test(raw)) {
      return { ok: false, error: 'NO_BALANCE' };
    }
    if (/^BAD_SERVICE$/i.test(raw)) {
      return { ok: false, error: 'BAD_SERVICE' };
    }
    if (/^BAD_KEY$/i.test(raw)) {
      return { ok: false, error: 'BAD_KEY' };
    }
    if (/^BANNED/i.test(raw)) {
      return { ok: false, error: 'BANNED', raw };
    }
    return { ok: false, error: raw || 'UNKNOWN' };
  }

  function parseGetStatusResponse(text) {
    const raw = String(text == null ? '' : text).trim();
    if (/^STATUS_WAIT_CODE$/i.test(raw)) {
      return { status: 'WAIT_CODE' };
    }
    if (/^STATUS_WAIT_RESEND$/i.test(raw)) {
      return { status: 'WAIT_RESEND' };
    }
    const retry = /^STATUS_WAIT_RETRY:(.+)$/i.exec(raw);
    if (retry) {
      return { status: 'WAIT_RETRY', code: retry[1].trim() };
    }
    if (/^STATUS_CANCEL$/i.test(raw)) {
      return { status: 'CANCEL' };
    }
    const ok = /^STATUS_OK:(.+)$/i.exec(raw);
    if (ok) {
      return { status: 'OK', code: ok[1].trim() };
    }
    return { status: 'ERROR', error: raw || 'UNKNOWN' };
  }

  function parseSetStatusResponse(text) {
    const raw = String(text == null ? '' : text).trim();
    if (/^ACCESS_READY$/i.test(raw)) return { ok: true, result: 'READY' };
    if (/^ACCESS_RETRY_GET$/i.test(raw)) return { ok: true, result: 'RETRY_GET' };
    if (/^ACCESS_ACTIVATION$/i.test(raw)) return { ok: true, result: 'ACTIVATION' };
    if (/^ACCESS_CANCEL$/i.test(raw)) return { ok: true, result: 'CANCEL' };
    if (/^EARLY_CANCEL_DENIED$/i.test(raw)) return { ok: false, error: 'EARLY_CANCEL_DENIED' };
    return { ok: false, error: raw || 'UNKNOWN' };
  }

  function pickLowestPrice(pricesResponse, { service, country } = {}) {
    if (!pricesResponse || typeof pricesResponse !== 'object') return null;
    const serviceKey = String(service || '');
    const countryKey = String(country == null ? '' : country);
    if (!serviceKey) return null;

    const tryEntry = (entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const cost = Number(entry.cost);
      const count = Number(entry.count);
      if (Number.isFinite(cost) && cost > 0 && Number.isFinite(count) && count > 0) {
        return cost;
      }
      return null;
    };

    const scopedByCountry = countryKey && pricesResponse[countryKey];
    if (scopedByCountry && typeof scopedByCountry === 'object') {
      const direct = tryEntry(scopedByCountry[serviceKey]);
      if (direct !== null) return direct;
    }

    const directService = tryEntry(pricesResponse[serviceKey]);
    if (directService !== null) return directService;

    let lowest = null;
    for (const outerValue of Object.values(pricesResponse)) {
      if (!outerValue || typeof outerValue !== 'object') continue;
      const candidate = tryEntry(outerValue[serviceKey]);
      if (candidate !== null && (lowest === null || candidate < lowest)) {
        lowest = candidate;
      }
    }
    return lowest;
  }

  function stripDialPrefix(phone, { country } = {}) {
    const raw = String(phone == null ? '' : phone).replace(/[^0-9+]/g, '');
    if (!raw) return '';
    const digits = raw.replace(/^\+/, '');
    let dial = '';
    if (country === 52) dial = '66';
    if (country === 6) dial = '62';
    if (country === 16) dial = '44';
    if (country === 41) dial = '237';
    if (dial && digits.startsWith(dial)) {
      return digits.slice(dial.length);
    }
    return digits;
  }

  const COUNTRY_ID_TO_ISO = Object.freeze({
    52: 'TH',
    6: 'ID',
    16: 'GB',
    41: 'CM',
  });

  function resolveCountryIso(countryId) {
    return COUNTRY_ID_TO_ISO[Number(countryId)] || '';
  }

  async function heroSmsGet(apiKey, action, params, { fetchImpl } = {}) {
    const fetchFn = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) {
      throw new Error('HeroSMS 请求失败：当前环境没有可用的 fetch 实现。');
    }
    if (!apiKey) {
      throw new Error('HeroSMS 请求失败：缺少 api_key。');
    }
    const url = buildHeroSmsRequestUrl(action, params, apiKey);
    const response = await fetchFn(url, { method: 'GET' });
    const status = response?.status ?? 0;
    let text = '';
    if (typeof response?.text === 'function') {
      text = await response.text().catch(() => '');
    }
    if (status && status >= 400) {
      const error = new Error(`HeroSMS HTTP ${status}: ${text || response?.statusText || ''}`);
      error.status = status;
      error.body = text;
      throw error;
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    return { text, json, status };
  }

  async function getBalance(apiKey, options = {}) {
    const { text } = await heroSmsGet(apiKey, 'getBalance', {}, options);
    return parseBalanceResponse(text);
  }

  async function getPrices(apiKey, { service, country } = {}, options = {}) {
    const { json, text } = await heroSmsGet(apiKey, 'getPrices', { service, country }, options);
    return { json, text };
  }

  async function getNumber(apiKey, { service, country, maxPrice } = {}, options = {}) {
    const params = { service, country };
    if (Number.isFinite(Number(maxPrice)) && Number(maxPrice) > 0) {
      params.maxPrice = Number(maxPrice);
    }
    const { text } = await heroSmsGet(apiKey, 'getNumber', params, options);
    return parseGetNumberResponse(text);
  }

  async function getStatus(apiKey, activationId, options = {}) {
    const { text } = await heroSmsGet(apiKey, 'getStatus', { id: activationId }, options);
    return parseGetStatusResponse(text);
  }

  async function setStatus(apiKey, activationId, status, options = {}) {
    const { text } = await heroSmsGet(apiKey, 'setStatus', { id: activationId, status }, options);
    return parseSetStatusResponse(text);
  }

  return {
    HERO_SMS_BASE_URL,
    HERO_SMS_DEFAULT_COUNTRY,
    HERO_SMS_DEFAULT_SERVICE,
    HERO_SMS_DEFAULT_POLL_INTERVAL_MS,
    HERO_SMS_DEFAULT_POLL_TIMEOUT_MS,
    ACTIVATION_STATUS,
    DEFAULT_CONFIG,
    normalizeHeroSmsConfig,
    buildHeroSmsRequestUrl,
    parseBalanceResponse,
    parseGetNumberResponse,
    parseGetStatusResponse,
    parseSetStatusResponse,
    pickLowestPrice,
    stripDialPrefix,
    COUNTRY_ID_TO_ISO,
    resolveCountryIso,
    getBalance,
    getPrices,
    getNumber,
    getStatus,
    setStatus,
  };
});
