/**
 * Shared CLI-internal shape for a Note.
 *
 * Both backends (HttpBackend / DirectBackend) normalize their source
 * format into this structure before returning it to the command layer.
 * Timestamps are milliseconds since the Unix epoch (numeric). The final
 * `owl get` / `owl create` / … stdout schema (design §3.2) is derived
 * from this internal type by a small output serializer — commands
 * never hand-build the CLI JSON directly.
 */
export interface CliNote {
  id: string;
  content: string;
  folderId: string | null;
  trashLevel: number;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  autoDeleteAt: number | null;
  contentHash: string | null;
  tags: CliNoteTag[];
}

export interface CliNoteTag {
  id: string;
  tagType: string;
  tagValue: string;
}

export interface CliFolder {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
}

export interface CliHashtagTag {
  value: string;
  count?: number;
}

export interface NoteListResult {
  items: CliNote[];
  total: number;
  page: number;
  limit: number;
}

export interface ListNotesQuery {
  q?: string;
  limit?: number;
  page?: number;
  folderId?: string | null;
  includeDescendants?: boolean;
  tags?: string[];
  trashLevel?: number;
  sortBy?: 'updated' | 'created';
  sortOrder?: 'asc' | 'desc';
}

export interface CreateNoteInput {
  content: string;
  folderId?: string | null;
  tags?: string[];
}

/** Partial update (PATCH). Only provided fields are written. */
export interface UpdateNoteInput {
  content?: string;
  folderId?: string | null;
  tags?: string[];
}

/** Full replace (PUT). All three fields must be supplied. */
export interface ReplaceNoteInput {
  content: string;
  folderId: string | null;
  tags: string[];
}

export interface CasOptions {
  expectedUpdatedAt?: number;
}

export interface DeleteNoteOptions extends CasOptions {
  /** When `true`, reject a `trash_level >= 1` note with ALREADY_TRASHED. */
  rejectIfTrashed?: boolean;
}

export interface ListHashtagTagsOptions {
  frequent?: boolean;
  limit?: number;
}

export interface OwlBackend {
  readonly mode: 'http' | 'direct';

  listNotes(query: ListNotesQuery): Promise<NoteListResult>;
  getNote(id: string): Promise<CliNote | null>;
  createNote(input: CreateNoteInput): Promise<CliNote>;
  /** PATCH semantics. */
  updateNote(id: string, input: UpdateNoteInput, opts?: CasOptions): Promise<CliNote | null>;
  /** PUT strict replace. */
  replaceNote(id: string, input: ReplaceNoteInput, opts?: CasOptions): Promise<CliNote | null>;
  deleteNote(id: string, opts?: DeleteNoteOptions): Promise<CliNote | null>;
  restoreNote(id: string, opts?: CasOptions): Promise<CliNote | null>;
  listFolders(): Promise<CliFolder[]>;
  listHashtagTags(opts?: ListHashtagTagsOptions): Promise<CliHashtagTag[]>;

  /** Release resources (close sqlite, free fetch state, …). */
  close(): Promise<void>;
}
