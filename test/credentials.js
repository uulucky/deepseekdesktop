'use strict';
/** Credential compatibility tests — no Electron, no network and no real user data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-credentials-'));
process.env.DEEPSEEK_DESKTOP_HOME = root;

const {
  isMissingCredentialsRoute,
  writeLocalCredential,
  applyHarnessCredential,
  createAndApplyPlatformKey,
} = require('../src/main/modules/credentials');
const YAML = require('yaml');

async function main() {
  const filename = path.join(root, 'harness', '.credentials.yaml');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, [
    'version: 1',
    'refs:',
    '  OPENAI_API_KEY: keep-this',
    'records:',
    '  plugin/example:',
    '    kind: grant',
    '    payload:',
    '      enabled: true',
    '',
  ].join('\n'));

  await writeLocalCredential('DEEPSEEK_API_KEY', 'sk-fallback-secret-value');
  const parsed = YAML.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(parsed.refs.DEEPSEEK_API_KEY, 'sk-fallback-secret-value');
  assert.equal(parsed.refs.OPENAI_API_KEY, 'keep-this');
  assert.equal(parsed.records['plugin/example'].payload.enabled, true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o077, 0);

  let describes = 0;
  const legacyClient = {
    credentialsSet: async () => { throw new Error('credentials/set: invalid reply (HTTP 404, credentials/set)'); },
    credentialsDescribe: async () => ({
      DEEPSEEK_API_KEY: { configured: ++describes > 1, source: 'file', writable: true },
    }),
  };
  const applied = await applyHarnessCredential(legacyClient, 'DEEPSEEK_API_KEY', 'sk-second-secret-value', {
    filename, confirmAttempts: 3,
  });
  assert.equal(applied.configured, true);
  assert.equal(applied.method, 'file');
  assert.equal(YAML.parse(fs.readFileSync(filename, 'utf8')).refs.DEEPSEEK_API_KEY, 'sk-second-secret-value');
  assert.equal(isMissingCredentialsRoute(new Error('credentials/set: invalid reply (HTTP 404, credentials/set)')), true);
  assert.equal(isMissingCredentialsRoute(new Error('credentials/set: credential rejected')), false);

  const created = await createAndApplyPlatformKey({
    createApiKey: async () => ({ name: 'one-time', secret: 'sk-one-time-secret-value' }),
  }, {
    credentialsSet: async () => { throw new Error('credential store is read-only'); },
  });
  assert.equal(created.created.applied, false);
  assert.equal(created.created.secret, 'sk-one-time-secret-value');
  assert.match(created.created.applyError, /read-only/);

  console.log('PASS credential compatibility — isolated kernel, managed-file fallback and one-time secret recovery');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
