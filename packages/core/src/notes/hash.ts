import { createHash } from 'node:crypto';

/** Compute SHA-256 hash of content. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}
