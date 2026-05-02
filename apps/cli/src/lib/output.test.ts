import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CliError } from './errors.js';
import { writeError, writeNdjson, writeProgress, writeRaw, writeResult } from './output.js';

/** In-memory writable stream for capturing writer output. */
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

function streams() {
  const stdout = buffer();
  const stderr = buffer();
  return { stdout, stderr, streams: { stdout: stdout.stream, stderr: stderr.stream } };
}

describe('writeResult', () => {
  it('writes compact JSON to stdout by default', () => {
    const { stdout, stderr, streams: io } = streams();
    writeResult({ a: 1, b: [1, 2] }, { streams: io });
    expect(stdout.read()).toBe('{"a":1,"b":[1,2]}\n');
    expect(stderr.read()).toBe('');
  });

  it('pretty-prints with 2-space indent when pretty=true', () => {
    const { stdout, streams: io } = streams();
    writeResult({ a: 1 }, { pretty: true, streams: io });
    expect(stdout.read()).toBe('{\n  "a": 1\n}\n');
  });
});

describe('writeRaw', () => {
  it('writes text verbatim and appends trailing newline only when missing', () => {
    const a = streams();
    writeRaw('hello', { streams: a.streams });
    expect(a.stdout.read()).toBe('hello\n');
    const b = streams();
    writeRaw('world\n', { streams: b.streams });
    expect(b.stdout.read()).toBe('world\n');
  });
});

describe('writeNdjson', () => {
  it('writes one JSON object per line to stdout', () => {
    const { stdout, streams: io } = streams();
    writeNdjson([{ id: 'a' }, { id: 'b' }], { streams: io });
    expect(stdout.read()).toBe('{"id":"a"}\n{"id":"b"}\n');
  });
});

describe('writeProgress', () => {
  it('writes JSON line to stderr, never stdout', () => {
    const { stdout, stderr, streams: io } = streams();
    writeProgress({ phase: 'backup' }, { streams: io });
    expect(stdout.read()).toBe('');
    expect(stderr.read()).toBe('{"phase":"backup"}\n');
  });
});

describe('writeError', () => {
  it('writes { error: { code, message, details } } to stderr for CliError', () => {
    const { stderr, streams: io } = streams();
    writeError(new CliError('NOTE_NOT_FOUND', 'note abc not found', { id: 'abc' }), {
      streams: io,
    });
    expect(JSON.parse(stderr.read())).toEqual({
      error: { code: 'NOTE_NOT_FOUND', message: 'note abc not found', details: { id: 'abc' } },
    });
  });

  it('omits details when absent', () => {
    const { stderr, streams: io } = streams();
    writeError(new CliError('DB_BUSY', 'locked'), { streams: io });
    expect(JSON.parse(stderr.read())).toEqual({
      error: { code: 'DB_BUSY', message: 'locked' },
    });
  });

  it('maps a plain Error to UNKNOWN', () => {
    const { stderr, streams: io } = streams();
    writeError(new Error('boom'), { streams: io });
    expect(JSON.parse(stderr.read())).toEqual({
      error: { code: 'UNKNOWN', message: 'boom' },
    });
  });
});
