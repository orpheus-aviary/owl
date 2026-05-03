import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/errors.js';
import { renderOwlSkillTemplate } from './skill-template.js';
import { runSkillExport } from './skill.js';

function buffer(): { stream: Writable; read(): string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
}

function setup() {
  const stdout = buffer();
  const stderr = buffer();
  return {
    stdout,
    stderr,
    streams: { stdout: stdout.stream, stderr: stderr.stream },
  };
}

// All 15 commands currently registered in apps/cli/src/index.ts. Test
// asserts each name appears somewhere in the rendered template so that
// adding/removing a command forces a template update (fails loudly).
const COMMAND_NAMES = [
  'owl search',
  'owl get',
  'owl create',
  'owl edit',
  'owl append',
  'owl tag',
  'owl delete',
  'owl restore',
  'owl trash list',
  'owl folders list',
  'owl tags list',
  'owl doctor',
  'owl open',
  'owl migrate',
  'owl skill export',
];

describe('renderOwlSkillTemplate', () => {
  const rendered = renderOwlSkillTemplate({ version: '1.2.3-test' });

  it('starts with YAML frontmatter with name: owl', () => {
    expect(rendered.startsWith('---\n')).toBe(true);
    const fmEnd = rendered.indexOf('\n---\n', 4);
    expect(fmEnd).toBeGreaterThan(0);
    const frontmatter = rendered.slice(4, fmEnd);
    const nameLine = frontmatter.split('\n').find((l) => l.startsWith('name:'));
    expect(nameLine).toBe('name: owl');
  });

  it('description is substantive (>80 chars) and mentions trigger phrases', () => {
    const descStart = rendered.indexOf('description:');
    const descEnd = rendered.indexOf('\n---\n', descStart);
    const desc = rendered.slice(descStart, descEnd);
    expect(desc.length).toBeGreaterThan(80);
    expect(desc).toMatch(/owl/i);
    expect(desc).toMatch(/notes?/i);
  });

  it('injects the version into the body', () => {
    expect(rendered).toContain('1.2.3-test');
  });

  it('mentions every currently-registered command', () => {
    for (const name of COMMAND_NAMES) {
      expect(rendered).toContain(name);
    }
  });

  it('exit code table covers all 7 values', () => {
    // Match the table rows for each code. Values may appear elsewhere in
    // prose, but the table cells are the authoritative source.
    for (const code of ['0', '1', '2', '3', '4', '5', '130']) {
      expect(rendered).toMatch(new RegExp(`\\|\\s*${code}\\s*\\|`));
    }
  });

  it('does NOT document the {success, data, message} envelope', () => {
    // Reality: each command prints raw business JSON. Regressing to the
    // HTTP-daemon envelope would mislead agents into wrong parsing.
    expect(rendered).not.toContain('"success":');
    expect(rendered).not.toMatch(/\{\s*success\s*,\s*data\s*,\s*message\s*\}/);
  });

  it('documents the error envelope shape with code+message', () => {
    expect(rendered).toContain('"error"');
    expect(rendered).toMatch(/"code"/);
    expect(rendered).toMatch(/"message"/);
  });
});

describe('runSkillExport', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'owl-skill-test-'));
  });

  afterEach(async () => {
    // Best-effort cleanup; tmpdir eventually reaps anyway
    await import('node:fs/promises').then((fs) =>
      fs.rm(tmp, { recursive: true, force: true }).catch(() => {}),
    );
  });

  it('writes to --output <file.md> exactly', async () => {
    const target = join(tmp, 'out.md');
    const { streams } = setup();
    const result = await runSkillExport(
      { output: target, human: true },
      { streams, version: '0.0.1' },
    );
    expect(result.path).toBe(target);
    const body = await readFile(target, 'utf8');
    expect(body).toContain('0.0.1');
  });

  it('writes to <dir>/owl-skill.md when --output is a directory', async () => {
    const { streams } = setup();
    const result = await runSkillExport(
      { output: tmp, human: true },
      { streams, version: '0.0.1' },
    );
    expect(result.path).toBe(join(tmp, 'owl-skill.md'));
    await expect(stat(result.path)).resolves.toBeDefined();
  });

  it('creates nested parent directories when they do not exist', async () => {
    const deep = join(tmp, 'nested', 'deep', 'skill.md');
    const { streams } = setup();
    const result = await runSkillExport(
      { output: deep, human: true },
      { streams, version: '0.0.1' },
    );
    expect(result.path).toBe(deep);
    const info = await stat(deep);
    expect(info.isFile()).toBe(true);
  });

  it('default (no flag) prints human output with divider and prompt', async () => {
    const target = join(tmp, 'out.md');
    const { stdout, streams } = setup();
    await runSkillExport({ output: target }, { streams, version: '0.0.1' });
    const out = stdout.read();
    expect(out).toContain('✓');
    expect(out).toContain(target);
    expect(out).toContain('────');
  });

  it('--json prints flat {path, prompt} and nothing else on stdout', async () => {
    const target = join(tmp, 'out.md');
    const { stdout, streams } = setup();
    await runSkillExport({ output: target, json: true }, { streams, version: '0.0.1' });
    const line = stdout.read().trim();
    // Compact JSON by default (no --pretty); exactly one line.
    expect(line.split('\n')).toHaveLength(1);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({
      path: target,
      prompt: expect.any(String),
    });
    // Reverse assertion: no envelope leaked in.
    expect(parsed).not.toHaveProperty('success');
    expect(parsed).not.toHaveProperty('data');
  });

  it('--json --human throws USAGE_ERROR at the command layer', async () => {
    const { streams } = setup();
    await expect(
      runSkillExport(
        { output: join(tmp, 'x.md'), json: true, human: true },
        { streams, version: '0.0.1' },
      ),
    ).rejects.toBeInstanceOf(CliError);
    await expect(
      runSkillExport(
        { output: join(tmp, 'x.md'), json: true, human: true },
        { streams, version: '0.0.1' },
      ),
    ).rejects.toMatchObject({ code: 'USAGE_ERROR' });
  });

  it('overwrites an existing file without error', async () => {
    const target = join(tmp, 'out.md');
    await mkdir(tmp, { recursive: true });
    await writeFile(target, 'pre-existing content', 'utf8');
    const { streams } = setup();
    await runSkillExport({ output: target, human: true }, { streams, version: '0.0.1' });
    const body = await readFile(target, 'utf8');
    expect(body).not.toContain('pre-existing content');
    expect(body).toContain('0.0.1');
  });
});
