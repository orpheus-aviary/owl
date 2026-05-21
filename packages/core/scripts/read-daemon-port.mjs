#!/usr/bin/env node
// Print the owl daemon port from $OWL_NEST_DIR/owl/owl_config.toml.
// Falls back to 47010 (DEFAULT_CONFIG.daemon.port) on any read/parse failure.
//
// Lives in `packages/core/scripts/` so pnpm resolves `smol-toml` via core's
// own dependency tree — works regardless of root hoisting settings. The
// alternative (running `node -e require('smol-toml')` from repo root)
// fails on strict-hoisting setups because root package.json doesn't
// declare smol-toml.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

const DEFAULT_PORT = 47010;
const nestDir =
  process.env.OWL_NEST_DIR && process.env.OWL_NEST_DIR.length > 0
    ? process.env.OWL_NEST_DIR
    : join(homedir(), 'orpheus-aviary-nest');

try {
  const cfg = parse(readFileSync(join(nestDir, 'owl', 'owl_config.toml'), 'utf8'));
  const port = cfg?.daemon?.port;
  console.log(typeof port === 'number' && Number.isFinite(port) ? port : DEFAULT_PORT);
} catch {
  console.log(DEFAULT_PORT);
}
