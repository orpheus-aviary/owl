import { listFolders } from '@owl/core';
import type { ToolDef } from '../tool-registry.js';

export const listFoldersTool: ToolDef = {
  name: 'list_folders',
  description:
    'Return all folders as a flat list with parent_id, ordered by parent then position. ' +
    'The caller can assemble the tree if needed. Useful before drafting a `create_note` or ' +
    '`update_note` that should land in a particular folder.',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const folders = listFolders(ctx.db);
    return {
      folders: folders.map((f) => ({
        id: f.id,
        name: f.name,
        parent_id: f.parentId,
        position: f.position,
      })),
    };
  },
};
