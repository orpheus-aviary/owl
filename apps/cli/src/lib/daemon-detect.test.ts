import { describe, expect, it, vi } from 'vitest';
import { detectDaemon } from './daemon-detect.js';

describe('detectDaemon', () => {
  it('returns true when /status is 200 + success=true', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ success: true, data: { status: 'ok' } }),
    });
    const result = await detectDaemon(47010, { fetch: fetchMock as unknown as typeof fetch });
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:47010/status',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('returns false when status is non-200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ status: 500, json: async () => ({ success: false }) });
    expect(await detectDaemon(47010, { fetch: fetchMock as unknown as typeof fetch })).toBe(false);
  });

  it('returns false when body.success is falsy', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) });
    expect(await detectDaemon(47010, { fetch: fetchMock as unknown as typeof fetch })).toBe(false);
  });

  it('returns false when fetch rejects (network down, timeout, …)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await detectDaemon(47010, { fetch: fetchMock as unknown as typeof fetch })).toBe(false);
  });
});
