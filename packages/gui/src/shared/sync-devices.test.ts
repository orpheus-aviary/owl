import { describe, expect, it } from 'vitest';
import {
  hiddenDevicesNote,
  isOwlDevice,
  revokedDevicesLabel,
  splitOwlDevices,
  splitRevokedDevices,
} from './sync-devices.js';

describe('isOwlDevice', () => {
  it('claims owl registrations, in any casing, with or without a version', () => {
    expect(isOwlDevice('owl 0.6.3')).toBe(true);
    expect(isOwlDevice('OWL 0.6.3')).toBe(true);
    expect(isOwlDevice('owl')).toBe(true);
  });

  it('leaves other tools out', () => {
    expect(isOwlDevice('lark 0.4.1')).toBe(false);
    expect(isOwlDevice('owlet 1.0')).toBe(false); // prefix match must not be substring match
  });

  // The careful half: unknown cannot be proven not to be ours, and this list is
  // where somebody goes to revoke a device they no longer trust.
  it('shows an unknown app rather than hiding it', () => {
    expect(isOwlDevice(null)).toBe(true);
  });
});

describe('splitOwlDevices', () => {
  const rows = [
    { app_version: 'owl 0.6.3' },
    { app_version: 'lark 0.4.1' },
    { app_version: null },
    { app_version: 'lark 0.4.1' },
  ];

  it('keeps ours plus the unknown, and counts what it dropped', () => {
    const split = splitOwlDevices(rows, (r) => r.app_version);
    expect(split.shown).toEqual([{ app_version: 'owl 0.6.3' }, { app_version: null }]);
    expect(split.hidden).toBe(2);
  });

  it('says nothing when it hides nothing', () => {
    expect(hiddenDevicesNote(0)).toBeNull();
    expect(hiddenDevicesNote(-1)).toBeNull();
  });

  it('names the count and where to go instead', () => {
    const note = hiddenDevicesNote(2);
    expect(note).toContain('2 台');
    expect(note).toContain('凭证');
  });
});

describe('splitRevokedDevices', () => {
  it('separates tombstones from usable devices, preserving order', () => {
    const rows = [
      { id: 'a', revoked_at: null },
      { id: 'b', revoked_at: 1 },
      { id: 'c', revoked_at: null },
    ];
    const split = splitRevokedDevices(rows, (r) => r.revoked_at);
    expect(split.active.map((r) => r.id)).toEqual(['a', 'c']);
    expect(split.revoked.map((r) => r.id)).toEqual(['b']);
  });

  it('has no fold when there is nothing behind it', () => {
    expect(revokedDevicesLabel(0, false)).toBeNull();
  });

  it('labels the fold both ways', () => {
    expect(revokedDevicesLabel(3, false)).toBe('显示已撤销的 3 台');
    expect(revokedDevicesLabel(3, true)).toBe('收起已撤销的 3 台');
  });
});
