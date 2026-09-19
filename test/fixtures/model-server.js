'use strict';
// Loopback-only, controlled SSE provider. Never contacts DeepSeek or runs tools.
const http = require('node:http');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, message, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail(message);
}
async function startModelServer() {
  const requests = [];
  const webResponses = [];
  const webRequests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/web-fixture') {
      const response = webResponses.shift() ?? { status: 200 };
      webRequests.push({ time: Date.now(), status: response.status, userAgent: req.headers['user-agent'] });
      res.writeHead(response.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        ...(response.retryAfter ? { 'Retry-After': response.retryAfter } : {}) });
      if (response.status === 429) { res.end('<h1>Rate Limit Reached</h1>'); return; }
      if (response.status === 403) { res.end('<h1 id="verify">需要验证</h1><a href="/web-fixture">继续</a>'); return; }
      res.end('<!doctype html><meta charset="utf-8"><title>DeepSeek Web Fixture</title><h1 id="ready">网页版夹具</h1><main id="long"></main><script>window.fixtureIdentity=sessionStorage.fixtureIdentity||(sessionStorage.fixtureIdentity=crypto.randomUUID());document.getElementById("long").textContent="长对话".repeat(200000);</script>');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/chat/completions') {
      res.writeHead(404); res.end(); return;
    }
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const request = {
      body, closed: false,
      delta(text) {
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
          model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
      },
      reasoning(text) {
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
          model: body.model, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: text }, finish_reason: null }] })}\n\n`);
      },
      finish(text) {
        if (text) this.delta(text);
        res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
      },
    };
    res.on('close', () => { request.closed = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    requests.push(request);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`, requests, webResponses, webRequests,
    async waitFor(marker) {
      const find = () => requests.find(request => request.body.messages?.some(message => (
        message.role === 'user' && JSON.stringify(message.content).includes(marker)
      )));
      await eventually(find, `Local provider did not receive ${marker}`);
      return find();
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
module.exports = { startModelServer, eventually };
