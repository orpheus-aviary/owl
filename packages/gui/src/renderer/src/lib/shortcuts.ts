// Canonical shortcut string format: `[Mod-][Alt-][Shift-]<Code>`
//
// `Mod` = Cmd on macOS, Ctrl elsewhere. `<Code>` is a KeyboardEvent.code value
// such as `KeyS`, `Digit1`, `Slash`, `Comma`, `ArrowUp`. Using `e.code` keeps
// recorded bindings stable across keyboard layouts and avoids the Alt+letter
// dead-key problem where `e.key` becomes `Ω` / `ß`.

export interface ShortcutParts {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  code: string;
}

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

/** True if `e.code` is a standalone modifier key (not a valid binding target). */
export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/** Parse a canonical shortcut string into its parts. Returns null if invalid. */
export function parseShortcut(str: string): ShortcutParts | null {
  if (!str) return null;
  const tokens = str.split('-');
  const code = tokens.pop();
  if (!code) return null;
  const mods = new Set(tokens);
  return {
    mod: mods.has('Mod'),
    alt: mods.has('Alt'),
    shift: mods.has('Shift'),
    code,
  };
}

/** Serialize parts back to canonical form. */
export function serializeShortcut(parts: ShortcutParts): string {
  const out: string[] = [];
  if (parts.mod) out.push('Mod');
  if (parts.alt) out.push('Alt');
  if (parts.shift) out.push('Shift');
  out.push(parts.code);
  return out.join('-');
}

/** Build a canonical shortcut string from a KeyboardEvent. */
export function shortcutFromEvent(e: KeyboardEvent): string | null {
  if (isModifierCode(e.code)) return null;
  return serializeShortcut({
    mod: e.metaKey || e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    code: e.code,
  });
}

/** True if the event matches the canonical shortcut string. */
export function matchesShortcut(e: KeyboardEvent, str: string): boolean {
  const parts = parseShortcut(str);
  if (!parts) return false;
  return (
    parts.mod === (e.metaKey || e.ctrlKey) &&
    parts.alt === e.altKey &&
    parts.shift === e.shiftKey &&
    parts.code === e.code
  );
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

const CODE_DISPLAY: Record<string, string> = {
  Space: 'Space',
  Escape: 'Esc',
  Enter: '↵',
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
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

/** Pretty-print a `<Code>` token for display. */
function formatCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return CODE_DISPLAY[code] ?? code;
}

/** Pretty display like `⌘S`, `⌘⌥V`, `⌥Z`, `Ctrl+Shift+S`. */
export function formatShortcut(str: string): string {
  const parts = parseShortcut(str);
  if (!parts) return str;
  if (IS_MAC) {
    const out: string[] = [];
    if (parts.mod) out.push('⌘');
    if (parts.alt) out.push('⌥');
    if (parts.shift) out.push('⇧');
    out.push(formatCode(parts.code));
    return out.join('');
  }
  const out: string[] = [];
  if (parts.mod) out.push('Ctrl');
  if (parts.alt) out.push('Alt');
  if (parts.shift) out.push('Shift');
  out.push(formatCode(parts.code));
  return out.join('+');
}
