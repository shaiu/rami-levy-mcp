import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RAMI_LEVY_TOOL_NAMES } from '../src/tools.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function baseEnv(dbPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('RAMI_LEVY_')) env[key] = value;
  }
  return {
    ...env,
    RAMI_LEVY_BEARER_TOKEN: 'dummy-token',
    RAMI_LEVY_ECOM_TOKEN: 'dummy-ecom-token',
    RAMI_LEVY_COOKIE: 'dummy-cookie',
    RAMI_LEVY_USER_AGENT: 'dummy-user-agent',
    RAMI_LEVY_DB_PATH: dbPath,
  };
}

function textOf(result: { content: { type: 'text'; text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

function runToExit(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', 'src/index.ts'], { cwd: REPO_ROOT, env });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

test('server starts, lists the registered tools, and view_cart works end to end', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-stdio-'));
  const dbPath = path.join(tmpDir, 'nested', 'does-not-exist-yet', 'cart.db');
  const env = baseEnv(dbPath);

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--import', 'tsx', 'src/index.ts'],
    cwd: REPO_ROOT,
    env,
  });
  const client = new Client({ name: 'rami-levy-mcp-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [...RAMI_LEVY_TOOL_NAMES].sort(),
    );

    const result = await client.callTool({ name: 'rami_levy_view_cart', arguments: {} });
    const out = textOf(result as { content: { type: 'text'; text: string }[] });
    assert.deepEqual(out, { ok: true, items: [], total: 0, checkoutUrl: 'https://www.rami-levy.co.il/he/dashboard/checkout' });
  } finally {
    await client.close();
  }
});

test('missing RAMI_LEVY_BEARER_TOKEN fails loudly and exits non-zero', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-stdio-'));
  const env = baseEnv(path.join(tmpDir, 'cart.db'));
  delete env.RAMI_LEVY_BEARER_TOKEN;

  const { code, stderr } = await runToExit(env);
  assert.notEqual(code, 0);
  assert.match(stderr, /missing required env var RAMI_LEVY_BEARER_TOKEN/);
});

test('RAMI_LEVY_BEARER_TOKEN left as the literal "placeholder" fails loudly and exits non-zero', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-stdio-'));
  const env = baseEnv(path.join(tmpDir, 'cart.db'));
  env.RAMI_LEVY_BEARER_TOKEN = 'placeholder';

  const { code, stderr } = await runToExit(env);
  assert.notEqual(code, 0);
  assert.match(stderr, /missing required env var RAMI_LEVY_BEARER_TOKEN/);
});
