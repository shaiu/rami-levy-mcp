#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CartStore } from './store.js';
import { RamiLevyClient } from './client.js';
import { registerRamiLevyTools } from './tools.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value === 'placeholder') {
    console.error(`rami-levy-mcp: missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

// RAMI_LEVY_COOKIE is optional (measured live 2026-09-18: not needed from an
// Israeli residential IP), but the literal "placeholder" left over from
// mcp.json is still rejected — same rule as the required vars, just without
// the "must be present" half.
function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  if (value === 'placeholder') {
    console.error(`rami-levy-mcp: env var ${name} is still set to "placeholder"`);
    process.exit(1);
  }
  return value;
}

const config = {
  bearerToken: requireEnv('RAMI_LEVY_BEARER_TOKEN'),
  ecomToken: requireEnv('RAMI_LEVY_ECOM_TOKEN'),
  cookie: optionalEnv('RAMI_LEVY_COOKIE'),
  userAgent: requireEnv('RAMI_LEVY_USER_AGENT'),
  store: process.env.RAMI_LEVY_STORE || '412',
};

const dbPath = process.env.RAMI_LEVY_DB_PATH || path.join(process.cwd(), 'cart.db');
// node:sqlite won't create a missing parent directory (e.g. the plugin's
// ${PLUGIN_DATA}/rami-levy/cart.db) — create it before opening the DB.
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const store = new CartStore(dbPath);
const client = new RamiLevyClient(config);

const server = new McpServer({ name: 'rami-levy-mcp', version: '0.2.0' });
registerRamiLevyTools(server, store, client);

await server.connect(new StdioServerTransport());
