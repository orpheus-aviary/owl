/**
 * Tiny narrowing helpers for tool argument validation.
 *
 * Tools receive `Record<string, unknown>` straight from the LLM after JSON
 * parsing — these helpers convert raw values to typed primitives, throwing a
 * descriptive Error that the agent loop turns into a tool error result.
 */

export function getString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v;
}

export function getNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${key} must be a finite number`);
  }
  return v;
}

export function getBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${key} must be a boolean`);
  return v;
}

export function getStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`${key} must be an array of strings`);
  }
  return v as string[];
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = getString(args, key);
  if (v === undefined || v === '') throw new Error(`${key} is required`);
  return v;
}

/**
 * Read a `string | null` argument while preserving the explicit `null`
 * intent — needed by folder_id where `null` means "root/unfiled" but
 * `undefined` means "don't filter".
 */
export function getNullableString(
  args: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in args)) return undefined;
  const v = args[key];
  if (v === null) return null;
  if (typeof v !== 'string') throw new Error(`${key} must be a string or null`);
  return v;
}
