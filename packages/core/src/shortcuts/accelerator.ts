// Convert owl's canonical shortcut string (e.g. `Mod-Alt-KeyO`) into an
// Electron globalShortcut accelerator (e.g. `CommandOrControl+Alt+O`).
//
// Canonical form mirrors the renderer's `lib/shortcuts.ts`:
//   `[Mod-][Alt-][Shift-]<Code>` where `<Code>` is a KeyboardEvent.code value.
// We keep one source of truth here so the main process can convert without
// pulling renderer code.

const CODE_TO_ACCELERATOR: Record<string, string> = {
  Space: 'Space',
  Escape: 'Esc',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Slash: '/',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

function codeToAccelerator(code: string): string | null {
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return CODE_TO_ACCELERATOR[code] ?? null;
}

/**
 * Convert canonical shortcut → Electron accelerator. Returns `null` if the
 * input is empty, malformed, or references a code that has no Electron
 * mapping. Caller should treat `null` as "skip registration" rather than
 * crashing — bad config shouldn't kill the main process.
 */
export function toElectronAccelerator(canonical: string): string | null {
  if (!canonical) return null;
  const tokens = canonical.split('-');
  if (tokens.length === 0) return null;
  const code = tokens.pop();
  if (!code) return null;
  const key = codeToAccelerator(code);
  if (!key) return null;
  const mods = new Set(tokens);
  const allowed = new Set(['Mod', 'Alt', 'Shift']);
  for (const m of mods) {
    if (!allowed.has(m)) return null;
  }
  const out: string[] = [];
  if (mods.has('Mod')) out.push('CommandOrControl');
  if (mods.has('Alt')) out.push('Alt');
  if (mods.has('Shift')) out.push('Shift');
  out.push(key);
  return out.join('+');
}
