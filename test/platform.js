'use strict';
/** Pure contract tests for the private-platform usage normalizers. */
const assert = require('node:assert/strict');
const {
  DeepSeekPlatform,
  apiKeyMutationBody,
  defaultKeyName,
  usageWindow,
  parseByApiKeyUsage,
  parseMonthlyUsage,
  plausibleToken,
} = require('../src/main/modules/platform');

const now = new Date(2026, 8, 14, 12, 0, 0);
const today = Math.floor(new Date(2026, 8, 14, 0, 0, 0).getTime() / 1000);

const byKey = parseByApiKeyUsage(
  {
    series: [{
      api_key: { name: 'desktop', tracking_id: 'key-1' },
      model: 'deepseek-chat',
      buckets: [{
        time: today,
        usage: {
          PROMPT_CACHE_HIT_TOKEN: '100',
          PROMPT_CACHE_MISS_TOKEN: 50,
          RESPONSE_TOKEN: 25,
          REQUEST: 2,
        },
      }],
    }],
  },
  { data: [{ currency: 'CNY', series: [{ buckets: [{ time: today, cost: '0.12' }] }] }] },
  now,
);

assert.equal(byKey.today.tokens, 175);
assert.equal(byKey.today.cost, 0.12);
assert.equal(byKey.today.requests, 2);
assert.equal(byKey.period.tokens, 175);
assert.equal(byKey.apiKeyCount, 1);
assert.equal(byKey.topModel, 'deepseek-chat');

const monthly = parseMonthlyUsage(
  { days: [{ date: '2026-09-14', data: [{ usage: [{ type: 'RESPONSE_TOKEN', amount: '40' }, { type: 'REQUEST', amount: '1' }] }] }] },
  [{ currency: 'CNY', days: [{ date: '2026-09-14', data: [{ usage: [{ type: 'RESPONSE_TOKEN', amount: '0.08' }] }] }] }],
  now,
);
assert.deepEqual(monthly.today, { date: '2026-09-14', tokens: 40, cost: 0.08, requests: 1 });
assert.equal(monthly.period.kind, 'currentMonth');

const window = usageWindow(now);
assert.equal(window.end - window.start, 30 * 86400);
assert.equal(window.timeZoneSeconds, -now.getTimezoneOffset() * 60);
assert.equal(plausibleToken('"Bearer sk-json-wrapped-token"'), 'sk-json-wrapped-token');

let headerListener = null;
const fakeSession = { webRequest: {
  onBeforeSendHeaders: (_filter, listener) => { headerListener = listener; },
  onCompleted: () => {},
} };
const platform = new DeepSeekPlatform({ session: fakeSession, getWindow: () => null });
let forwardedHeaders = null;
headerListener({ requestHeaders: { Authorization: 'Bearer sk-header-captured-token' } }, (reply) => {
  forwardedHeaders = reply.requestHeaders;
});
assert.equal(platform.token, 'sk-header-captured-token');
assert.equal(forwardedHeaders.Authorization, 'Bearer sk-header-captured-token');

assert.deepEqual(apiKeyMutationBody({ action: 'create', name: 'desktop' }), {
  action: 'create', name: 'desktop', redacted_key: null, created_at: null, tracking_id: null,
});
assert.deepEqual(apiKeyMutationBody({
  action: 'delete', redactedKey: 'sk-***', createdAt: 1789440000000, trackingId: 'track-1',
}), {
  action: 'delete', name: null, redacted_key: 'sk-***', created_at: 1789440000, tracking_id: 'track-1',
});
assert.match(defaultKeyName(now), /^DeepSeek Desktop 20260914-1200$/);

console.log('PASS platform contracts — usage, login token and current API Key mutations');
