import { randomUUID } from 'node:crypto';

/**
 * Stash for external-agent previews. Tier-2 write tools called with
 * `source: 'external'` deposit a payload here instead of mutating the DB,
 * so the caller can review and apply via `POST /ai/preview/apply`.
 *
 * Entries auto-expire after `DEFAULT_TTL_MS` to keep the map bounded;
 * sweep runs lazily on each `create` to avoid a long-lived timer (the
 * daemon already has the reminder scheduler doing periodic work).
 */

export const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export type PreviewAction = 'create' | 'update' | 'create_reminder';

export interface PreviewPayload {
  action: PreviewAction;
  /** Real note id (update only). Undefined for create / create_reminder. */
  note_id?: string;
  content: string;
  /** Raw tag strings (e.g. ["#x", "/alarm 2026-04-20T10:00:00"]). */
  tags: string[];
  /** Target folder. `null` = root/unfiled, `undefined` = don't change (update only). */
  folder_id?: string | null;
}

export interface StoredPreview {
  id: string;
  payload: PreviewPayload;
  createdAt: Date;
  expiresAt: Date;
}

export class PreviewStore {
  private readonly previews = new Map<string, StoredPreview>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  /** Create a new preview entry, returning the freshly-issued id. */
  create(payload: PreviewPayload): StoredPreview {
    this.sweepExpired();
    const id = `preview_${randomUUID()}`;
    const now = new Date();
    const entry: StoredPreview = {
      id,
      payload,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMs),
    };
    this.previews.set(id, entry);
    return entry;
  }

  get(id: string): StoredPreview | undefined {
    const entry = this.previews.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt.getTime() <= Date.now()) {
      this.previews.delete(id);
      return undefined;
    }
    return entry;
  }

  /** Atomically fetch + remove — used by `apply_update` after a successful write. */
  consume(id: string): StoredPreview | undefined {
    const entry = this.get(id);
    if (entry) this.previews.delete(id);
    return entry;
  }

  delete(id: string): boolean {
    return this.previews.delete(id);
  }

  list(): StoredPreview[] {
    this.sweepExpired();
    return [...this.previews.values()];
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.previews.entries()) {
      if (entry.expiresAt.getTime() <= now) this.previews.delete(id);
    }
  }
}
