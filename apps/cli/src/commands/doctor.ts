import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type StartupProbeResult, probeStartupState } from '@owl/core';
import type { ResolvedConfig } from '../lib/config.js';
import { detectDaemon } from '../lib/daemon-detect.js';
import type { OutputStreams } from '../lib/output.js';
import { writeResult } from '../lib/output.js';

export interface DoctorFlags {
  llm?: boolean;
  all?: boolean;
  pretty?: boolean;
}

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  value?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  status: 'ok' | 'warn' | 'fail';
  checks: DoctorCheck[];
}

function aggregate(checks: DoctorCheck[]): 'ok' | 'warn' | 'fail' {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

function envNode(): DoctorCheck {
  const required = 22;
  const match = process.version.match(/^v(\d+)/);
  const major = match ? Number(match[1]) : 0;
  if (major < required) {
    return {
      name: 'env.node',
      status: 'fail',
      value: process.version,
      message: `Node ${required}+ required (got ${process.version})`,
    };
  }
  return { name: 'env.node', status: 'ok', value: process.version };
}

function envSqlite(): DoctorCheck {
  try {
    const require_ = createRequire(import.meta.url);
    const sqlite = require_('better-sqlite3');
    const instance = new sqlite(':memory:');
    const version = instance.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    instance.close();
    return { name: 'env.sqlite', status: 'ok', value: version.v };
  } catch (err) {
    return {
      name: 'env.sqlite',
      status: 'fail',
      message: (err as Error).message,
    };
  }
}

function checkConfig(config: ResolvedConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push({
    name: 'config.file',
    status: existsSync(config.configPath) ? 'ok' : 'warn',
    value: config.configPath,
    ...(existsSync(config.configPath) ? {} : { message: 'config file not found (using defaults)' }),
  });
  checks.push({
    name: 'config.data_dir',
    status: existsSync(config.dataDir) ? 'ok' : 'warn',
    value: config.dataDir,
    ...(existsSync(config.dataDir)
      ? {}
      : { message: 'data dir missing — will be created on first write' }),
  });
  return checks;
}

function checkDb(dbPath: string): DoctorCheck {
  if (!existsSync(dbPath)) {
    return { name: 'db.file', status: 'warn', value: dbPath, message: 'db file does not exist' };
  }
  try {
    const probe: StartupProbeResult = probeStartupState(dbPath);
    const sizeMb = (statSync(dbPath).size / 1024 / 1024).toFixed(2);
    if (probe.kind === 'not-found') {
      return {
        name: 'db.file',
        status: 'warn',
        value: dbPath,
        message: 'db file missing at probe time',
      };
    }
    return {
      name: 'db.file',
      status: 'ok',
      value: dbPath,
      details: {
        user_version: probe.version,
        schema_empty: probe.schemaEmpty,
        size_mb: Number(sizeMb),
      },
    };
  } catch (err) {
    return { name: 'db.file', status: 'fail', value: dbPath, message: (err as Error).message };
  }
}

async function checkDaemon(port: number): Promise<DoctorCheck> {
  const alive = await detectDaemon(port);
  if (alive) return { name: 'daemon', status: 'ok', value: `127.0.0.1:${port}` };
  return {
    name: 'daemon',
    status: 'warn',
    message: 'not running',
    details: { port },
  };
}

export async function runDoctor(
  flags: DoctorFlags,
  deps: { config: ResolvedConfig; streams: OutputStreams },
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [envNode(), envSqlite()];
  checks.push(...checkConfig(deps.config));
  checks.push(checkDb(deps.config.dbPath));
  checks.push(await checkDaemon(deps.config.daemonPort));

  if (flags.llm || flags.all) {
    // LLM check is best-effort; the design says skipped when no key. Keep it minimal
    // and mark skipped — a real ping is reserved for post-P3.2-c.
    checks.push({ name: 'llm', status: 'skipped', message: 'not implemented in P3.2-c' });
  }

  const status = aggregate(checks);
  const report: DoctorReport = { status, checks };
  writeResult(report, { pretty: flags.pretty, streams: deps.streams });
  return report;
}
