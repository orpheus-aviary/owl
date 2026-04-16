import { ToolRegistry } from '../tool-registry.js';
import { addTodoTool } from './add-todo.js';
import { appendMemoTool } from './append-memo.js';
import { applyUpdateTool } from './apply-update.js';
import { createNoteTool } from './create-note.js';
import { createReminderTool } from './create-reminder.js';
import { getCapabilitiesTool } from './get-capabilities.js';
import { getNoteTool } from './get-note.js';
import { getRemindersTool } from './get-reminders.js';
import { getTodosTool } from './get-todos.js';
import { listFoldersTool } from './list-folders.js';
import { listTagsTool } from './list-tags.js';
import { searchNotesTool } from './search-notes.js';
import { updateNoteTool } from './update-note.js';

/**
 * Build a registry pre-populated with all built-in tools:
 *  • 7 read tools (search, get, list, capabilities)
 *  • 2 Tier-1 writes (append_memo, add_todo) — direct DB write
 *  • 4 Tier-2 writes (create_note, update_note, create_reminder, apply_update)
 *    — staged via draft (gui) or preview (external) and committed by the user
 *    or by `apply_update`.
 */
export function createBuiltinRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(searchNotesTool);
  reg.register(getNoteTool);
  reg.register(listTagsTool);
  reg.register(listFoldersTool);
  reg.register(getRemindersTool);
  reg.register(getTodosTool);
  reg.register(getCapabilitiesTool);
  reg.register(appendMemoTool);
  reg.register(addTodoTool);
  reg.register(createNoteTool);
  reg.register(updateNoteTool);
  reg.register(createReminderTool);
  reg.register(applyUpdateTool);
  return reg;
}

export {
  searchNotesTool,
  getNoteTool,
  listTagsTool,
  listFoldersTool,
  getRemindersTool,
  getTodosTool,
  getCapabilitiesTool,
  appendMemoTool,
  addTodoTool,
  createNoteTool,
  updateNoteTool,
  createReminderTool,
  applyUpdateTool,
};
