import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toElectronAccelerator } from './accelerator.js';

describe('toElectronAccelerator', () => {
  it('converts the default global invoke shortcut', () => {
    assert.equal(toElectronAccelerator('Mod-Alt-KeyO'), 'CommandOrControl+Alt+O');
  });

  it('converts letter shortcuts', () => {
    assert.equal(toElectronAccelerator('Mod-KeyS'), 'CommandOrControl+S');
    assert.equal(toElectronAccelerator('Alt-KeyZ'), 'Alt+Z');
  });

  it('converts digit shortcuts', () => {
    assert.equal(toElectronAccelerator('Mod-Digit1'), 'CommandOrControl+1');
  });

  it('preserves modifier order Mod-Alt-Shift', () => {
    assert.equal(toElectronAccelerator('Mod-Alt-Shift-KeyP'), 'CommandOrControl+Alt+Shift+P');
  });

  it('maps special codes', () => {
    assert.equal(toElectronAccelerator('Mod-Slash'), 'CommandOrControl+/');
    assert.equal(toElectronAccelerator('Mod-Comma'), 'CommandOrControl+,');
    assert.equal(toElectronAccelerator('Mod-Enter'), 'CommandOrControl+Return');
    assert.equal(toElectronAccelerator('Mod-Space'), 'CommandOrControl+Space');
    assert.equal(toElectronAccelerator('Mod-ArrowUp'), 'CommandOrControl+Up');
  });

  it('preserves function keys', () => {
    assert.equal(toElectronAccelerator('F12'), 'F12');
    assert.equal(toElectronAccelerator('Mod-F1'), 'CommandOrControl+F1');
  });

  it('returns null for empty / malformed input', () => {
    assert.equal(toElectronAccelerator(''), null);
    assert.equal(toElectronAccelerator('KeyNotExist'), null);
    assert.equal(toElectronAccelerator('Ctrl-KeyA'), null); // unknown mod
    assert.equal(toElectronAccelerator('Mod-Unknown'), null);
  });

  it('returns null for unmapped code', () => {
    assert.equal(toElectronAccelerator('Mod-CapsLock'), null);
  });
});
