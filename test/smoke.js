'use strict';
/**
 * Runtime smoke test — exercises the main-process modules against a real \`dsh web\` kernel.
 *
 *   node test/smoke.js [baseUrl]        # default http://127.0.0.1:3080
 *
 * It is read-only for the user's data: it lists sessions, folds a transcript, reads the model
 * catalog and credentials, and checks the official pricing parser. A full prompt round-trip
 * (which spends tokens and creates a session) only runs with --prompt.
 */
const path = require('node:path');

process.env.DEEPSEEK_DESKTOP_HOME = process.env.DEEPSEEK_DESKTOP_HOME
  || path.join(require('node:os').tmpdir(), 'deepseek-desktop-smoke');

const { DeepSeekHarnessClient } = require('../src/main/modules/api');
const { ChatController } = require('../src/main/modules/chat');
const { parsePricingTable, fetchCatalog } = require('../src/main/modules/catalog');

const BASE = process.argv.find((arg) => arg.startsWith('http')) || 'http://127.0.0.1:3080';
const WITH_PROMPT = process.argv.includes('--prompt');

let failures = 0;
function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' — ' + detail}`);
  return ok;
}

async function main() {
  const client = new DeepSeekHarnessClient(BASE);

  // ---------------------------------------------------------------- kernel API
  const sessions = await client.listSessions();
  check('session.list returns sessions', Array.isArray(sessions) && sessions.length > 0, `${sessions.length} sessions`);

  const providers = await client.listProviders();
  check('llm.providers lists deepseek-official', providers.some((p) => p.provider === 'deepseek-official' && p.active));

  const models = await client.listModels();
  const modelIds = (models.groups ?? []).flatMap((group) => (group.models ?? []).map((m) => m.id));
  check('llm.models returns model ids', modelIds.length > 0, modelIds.join(', '));

  const credentials = await client.credentialsDescribe(['DEEPSEEK_API_KEY']);
  check('credentials.describe answers for DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY' in credentials, JSON.stringify(credentials.DEEPSEEK_API_KEY));

  // ------------------------------------------------------------- transcript fold
  const target = sessions.filter((item) => !item.blank).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? sessions[0];
  const transcript = await client.history(target.sessionId, undefined, 4);
  check('session.history returns events', (transcript.events ?? []).length > 0, `${(transcript.events ?? []).length} events`);

  const chat = new ChatController(client, { onUpdate: () => {} });
  const snapshot = await chat.open(target.sessionId, { maxMessages: 8, maxPages: 3 });
  const kinds = snapshot.items.reduce((acc, item) => { acc[item.kind] = (acc[item.kind] ?? 0) + 1; return acc; }, {});
  check('transcript folds into renderable items', snapshot.items.length > 0, JSON.stringify(kinds));
  check('folded items are ordered by sequence', snapshot.items.every((item, index, all) => index === 0 || (item.seq ?? 0) >= (all[index - 1].seq ?? 0)));
  const assistantWithText = snapshot.items.find((item) => item.kind === 'assistant' && (item.parts ?? []).some((p) => p.kind === 'text'));
  if (assistantWithText) {
    check('assistant text survives folding', true, `${assistantWithText.parts.length} parts`);
  } else {
    // The newest tail can be tool-only; prove text folding on a session that has an answer.
    let found = false;
    for (const candidate of sessions.filter((item) => !item.blank).slice(0, 6)) {
      const probe = await chat.open(candidate.sessionId, { maxMessages: 8, maxPages: 3 });
      if (probe.items.some((item) => item.kind === 'assistant' && (item.parts ?? []).some((p) => p.kind === 'text'))) {
        found = true;
        break;
      }
    }
    check('assistant text survives folding (any recent session)', found);
  }

  // --------------------------------------------------------------- pricing docs
  const html = await fetch('https://api-docs.deepseek.com/zh-cn/quick_start/pricing', { headers: { 'user-agent': 'DeepSeekDesktop/test' } }).then((r) => r.text());
  const parsed = parsePricingTable(html);
  check('official pricing page parses', parsed.length > 0, parsed.map((m) => m.id).join(', '));
  const flash = parsed.find((m) => m.id === 'deepseek-flash');
  check('pricing tiers extracted', Boolean(flash && Object.keys(flash.pricing.tiers).length >= 6), flash ? JSON.stringify(flash.pricing.tiers) : 'none');
  const live = await fetchCatalog();
  check('fetchCatalog works end to end', live.models.length === parsed.length);

  // ---------------------------------------------------------------- live stream
  let frames = 0;
  const stop = client.onFrame(() => { frames += 1; });
  client.connect();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  check('mux websocket delivers frames', frames > 0, `${frames} frames`);
  stop();
  client.dispose();

  // ------------------------------------------------------------------- optional
  if (WITH_PROMPT) {
    const fresh = new DeepSeekHarnessClient(BASE);
    const controller = new ChatController(fresh, { onUpdate: () => {} });
    fresh.connect();
    const created = await controller.createSession({});
    check('session.create makes a session', Boolean(created.sessionId), created.sessionId);
    const echoed = await controller.send(created.sessionId, '仅回复两个字：好的');
    check('prompt echoes a user bubble', echoed.items.some((item) => item.kind === 'user'));
    await new Promise((resolve) => setTimeout(resolve, 20000));
    const after = await controller.refresh(created.sessionId);
    check('model answer lands in the transcript', after.items.some((item) => item.kind === 'assistant'), `${after.items.length} items`);
    controller.dispose();
    fresh.dispose();
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('smoke test crashed:', error);
  process.exit(2);
});
