import { describe, expect, it } from 'vitest';
import { CliError } from './errors.js';
import { resolveContentInput } from './input.js';

describe('resolveContentInput', () => {
  it('returns content mode for --body', async () => {
    const res = await resolveContentInput({ body: 'hello' });
    expect(res).toEqual({ mode: 'content', content: 'hello' });
  });

  it('returns content mode for --file (reads via env.readFile)', async () => {
    const res = await resolveContentInput(
      { file: '/tmp/note.md' },
      { readFile: async (p) => (p === '/tmp/note.md' ? 'from-disk' : '') },
    );
    expect(res).toEqual({ mode: 'content', content: 'from-disk' });
  });

  it('returns content mode for --stdin', async () => {
    const res = await resolveContentInput({ stdin: true }, { readStdin: async () => 'piped' });
    expect(res).toEqual({ mode: 'content', content: 'piped' });
  });

  it('returns full mode for --data JSON', async () => {
    const res = await resolveContentInput({
      data: '{"content":"x","folder_id":null,"tags":["#a"]}',
    });
    expect(res).toEqual({
      mode: 'full',
      parsed: { content: 'x', folder_id: null, tags: ['#a'] },
    });
  });

  it('returns full mode for --data-file (reads + parses JSON)', async () => {
    const res = await resolveContentInput(
      { dataFile: '/tmp/note.json' },
      { readFile: async () => '{"content":"y"}' },
    );
    expect(res).toEqual({ mode: 'full', parsed: { content: 'y' } });
  });

  it('throws INVALID_JSON_INPUT for malformed --data', async () => {
    await expect(resolveContentInput({ data: 'not-json' })).rejects.toMatchObject({
      code: 'INVALID_JSON_INPUT',
    });
  });

  it('throws USAGE_ERROR when --data lacks content field', async () => {
    await expect(resolveContentInput({ data: '{"tags":["#foo"]}' })).rejects.toMatchObject({
      code: 'USAGE_ERROR',
    });
  });

  it('throws USAGE_ERROR when --body and --file both provided', async () => {
    await expect(
      resolveContentInput({ body: 'a', file: '/p' }, { readFile: async () => '' }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('throws USAGE_ERROR when --body and --data both provided', async () => {
    await expect(resolveContentInput({ body: 'a', data: '{"content":"x"}' })).rejects.toMatchObject(
      {
        code: 'USAGE_ERROR',
      },
    );
  });

  it('auto-reads stdin when no flag is given and stdin is a pipe', async () => {
    const res = await resolveContentInput(
      {},
      { isStdinTty: () => false, readStdin: async () => 'pipe-content' },
    );
    expect(res).toEqual({ mode: 'content', content: 'pipe-content' });
  });

  it('throws USAGE_ERROR when no flag is given and stdin is a TTY', async () => {
    await expect(
      resolveContentInput({}, { isStdinTty: () => true, readStdin: async () => '' }),
    ).rejects.toMatchObject({ code: 'USAGE_ERROR' });
  });
});
