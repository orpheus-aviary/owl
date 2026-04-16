import type { ToolDef } from '../tool-registry.js';
import { getNumber, getString } from './args.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const listTagsTool: ToolDef = {
  name: 'list_tags',
  description:
    'List `#` hashtag values used across non-trashed notes, ordered by usage frequency desc. ' +
    "Useful for understanding the user's tagging conventions before suggesting a tag in a draft.",
  parameters: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description: 'Optional substring filter (case-insensitive LIKE on the tag value).',
      },
      limit: {
        type: 'number',
        description: `Max tags to return (default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT}).`,
      },
    },
  },
  async execute(args, ctx) {
    const search = getString(args, 'search');
    const limit = Math.min(getNumber(args, 'limit') ?? DEFAULT_LIMIT, MAX_LIMIT);

    const params: Array<string | number> = [];
    let whereSearch = '';
    if (search) {
      whereSearch = 'AND t.tag_value LIKE ? COLLATE NOCASE';
      params.push(`%${search}%`);
    }
    params.push(limit);

    const rows = ctx.sqlite
      .prepare(
        `SELECT t.tag_value AS value, COUNT(nt.note_id) AS usage_count
         FROM tags t
         JOIN note_tags nt ON t.id = nt.tag_id
         JOIN notes n ON nt.note_id = n.id AND n.trash_level = 0
         WHERE t.tag_type = '#' ${whereSearch}
         GROUP BY t.id
         ORDER BY usage_count DESC, t.tag_value ASC
         LIMIT ?`,
      )
      .all(...params) as Array<{ value: string; usage_count: number }>;

    return { tags: rows };
  },
};
