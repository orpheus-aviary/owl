import {
  AlreadyTrashedError,
  type NoteWithTags,
  type OwlDatabase,
  VersionMismatchError,
  createNote as coreCreateNote,
  deleteNote as coreDeleteNote,
  getNote as coreGetNote,
  listFolders as coreListFolders,
  listHashtagTags as coreListHashtagTags,
  listNotes as coreListNotes,
  restoreNote as coreRestoreNote,
  updateNote as coreUpdateNote,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
  parseTags,
} from '@owl/core';
import type Database from 'better-sqlite3';
import { withRetry } from '../lib/db-lock.js';
import { CliError } from '../lib/errors.js';
import type {
  CasOptions,
  CliFolder,
  CliHashtagTag,
  CliNote,
  CliNoteTag,
  CreateNoteInput,
  DeleteNoteOptions,
  ListHashtagTagsOptions,
  ListNotesQuery,
  NoteListResult,
  OwlBackend,
  ReplaceNoteInput,
  UpdateNoteInput,
} from './types.js';

export interface DirectBackendOptions {
  dbPath: string;
}

function toCliTag(t: { id: string; tagType: string; tagValue: string | null }): CliNoteTag {
  return { id: t.id, tagType: t.tagType, tagValue: t.tagValue ?? '' };
}

function toCliNote(n: NoteWithTags): CliNote {
  return {
    id: n.id,
    content: n.content,
    folderId: n.folderId,
    trashLevel: n.trashLevel,
    createdAt: n.createdAt.getTime(),
    updatedAt: n.updatedAt.getTime(),
    trashedAt: n.trashedAt ? n.trashedAt.getTime() : null,
    autoDeleteAt: n.autoDeleteAt ? n.autoDeleteAt.getTime() : null,
    contentHash: n.contentHash,
    tags: n.tags.map(toCliTag),
  };
}

/** Wrap a core throw into the CLI-shaped CliError. */
function wrapCoreError(err: unknown): never {
  if (err instanceof VersionMismatchError) {
    throw new CliError('VERSION_MISMATCH', err.message, {
      id: err.id,
      expected: err.expected,
      current: err.current,
    });
  }
  if (err instanceof AlreadyTrashedError) {
    throw new CliError('ALREADY_TRASHED', err.message, {
      id: err.id,
      current_trash_level: err.currentTrashLevel,
    });
  }
  throw err;
}

export async function createDirectBackend(options: DirectBackendOptions): Promise<OwlBackend> {
  // createDatabase is synchronous; the async wrapper keeps the
  // resolve-backend site uniform across http/direct.
  const { db, sqlite } = createDatabase({ dbPath: options.dbPath });
  ensureSpecialNotes(db);
  const deviceId = ensureDeviceId(db);

  function mapSync<T>(fn: () => T, label: string): Promise<T> {
    return withRetry(() => {
      try {
        return fn();
      } catch (err) {
        wrapCoreError(err);
      }
    }, label);
  }

  return {
    mode: 'direct',

    async listNotes(query: ListNotesQuery): Promise<NoteListResult> {
      const page = query.page ?? 1;
      const limit = query.limit ?? 20;
      const result = coreListNotes(db as OwlDatabase, sqlite as Database.Database, {
        q: query.q,
        folderId: query.folderId,
        includeDescendants: query.includeDescendants,
        tagValues: query.tags,
        trashLevel: query.trashLevel,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        page,
        limit,
      });
      return { items: result.items.map(toCliNote), total: result.total, page, limit };
    },

    async getNote(id: string): Promise<CliNote | null> {
      const note = coreGetNote(db, id);
      return note ? toCliNote(note) : null;
    },

    async createNote(input: CreateNoteInput): Promise<CliNote> {
      return mapSync(
        () =>
          toCliNote(
            coreCreateNote(db, sqlite, {
              content: input.content,
              folderId: input.folderId ?? null,
              tags: parseTags(input.tags ?? []),
              deviceId,
            }),
          ),
        'createNote',
      );
    },

    async updateNote(
      id: string,
      input: UpdateNoteInput,
      casOpts?: CasOptions,
    ): Promise<CliNote | null> {
      return mapSync(() => {
        const updated = coreUpdateNote(
          db,
          sqlite,
          id,
          {
            content: input.content,
            folderId: input.folderId,
            tags: input.tags !== undefined ? parseTags(input.tags) : undefined,
            deviceId,
          },
          casOpts?.expectedUpdatedAt !== undefined
            ? { expectedUpdatedAt: casOpts.expectedUpdatedAt }
            : undefined,
        );
        return updated ? toCliNote(updated) : null;
      }, 'updateNote');
    },

    async replaceNote(
      id: string,
      input: ReplaceNoteInput,
      casOpts?: CasOptions,
    ): Promise<CliNote | null> {
      return mapSync(() => {
        const updated = coreUpdateNote(
          db,
          sqlite,
          id,
          {
            content: input.content,
            folderId: input.folderId,
            tags: parseTags(input.tags),
            deviceId,
          },
          casOpts?.expectedUpdatedAt !== undefined
            ? { expectedUpdatedAt: casOpts.expectedUpdatedAt }
            : undefined,
        );
        return updated ? toCliNote(updated) : null;
      }, 'replaceNote');
    },

    async deleteNote(id: string, opts?: DeleteNoteOptions): Promise<CliNote | null> {
      return mapSync(() => {
        const deleted = coreDeleteNote(db, sqlite, id, {
          autoDeleteDays: 30, // Direct path inherits daemon default; config-aware path is P7
          expectedUpdatedAt: opts?.expectedUpdatedAt,
          rejectIfTrashed: opts?.rejectIfTrashed,
        });
        return deleted ? toCliNote(deleted) : null;
      }, 'deleteNote');
    },

    async restoreNote(id: string, opts?: CasOptions): Promise<CliNote | null> {
      return mapSync(() => {
        const restored = coreRestoreNote(
          db,
          sqlite,
          id,
          opts?.expectedUpdatedAt !== undefined
            ? { expectedUpdatedAt: opts.expectedUpdatedAt }
            : undefined,
        );
        return restored ? toCliNote(restored) : null;
      }, 'restoreNote');
    },

    async listFolders(): Promise<CliFolder[]> {
      const folders = coreListFolders(db);
      return folders.map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        position: f.position,
      }));
    },

    async listHashtagTags(opts?: ListHashtagTagsOptions): Promise<CliHashtagTag[]> {
      const rows = coreListHashtagTags(sqlite, opts);
      return rows.map((r) => {
        const out: CliHashtagTag = { value: r.value };
        if (r.count !== undefined) out.count = r.count;
        return out;
      });
    },

    async close(): Promise<void> {
      sqlite.close();
    },
  };
}
