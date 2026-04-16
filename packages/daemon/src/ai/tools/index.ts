import { ToolRegistry } from '../tool-registry.js';
import { addTodoTool } from './add-todo.js';
import { appendMemoTool } from './append-memo.js';
import { getCapabilitiesTool } from './get-capabilities.js';
import { getNoteTool } from './get-note.js';
import { getRemindersTool } from './get-reminders.js';
import { getTodosTool } from './get-todos.js';
import { listFoldersTool } from './list-folders.js';
import { listTagsTool } from './list-tags.js';
import { searchNotesTool } from './search-notes.js';

/**
 * Build a registry pre-populated with all P2-7b built-in tools (7 read +
 * 2 Tier-1 write). Tier-2 write tools (`create_note`, `update_note`,
 * `create_reminder`, `apply_update`) join in P2-7e.
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
};
