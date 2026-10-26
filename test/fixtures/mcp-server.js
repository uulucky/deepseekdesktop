'use strict';
// Minimal MCP stdio server (newline-delimited JSON-RPC 2.0) exposing one `echo` tool.
// Used only by the isolated integration test; it never touches the network or files.
const readline = require('node:readline');

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return; // notifications need no answer
  switch (request.method) {
    case 'initialize':
      send({ id: request.id, result: {
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'desktop-fixture', version: '1.0.0' },
      } });
      break;
    case 'tools/list':
      send({ id: request.id, result: { tools: [{
        name: 'echo',
        description: 'Echo the given text back (desktop integration fixture).',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }] } });
      break;
    case 'tools/call':
      send({ id: request.id, result: { content: [{ type: 'text', text: `echo:${request.params?.arguments?.text ?? ''}` }] } });
      break;
    case 'ping':
      send({ id: request.id, result: {} });
      break;
    default:
      send({ id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
  }
});
