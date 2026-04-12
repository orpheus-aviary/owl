import type { TodoItem } from './api';

// NOTE: This regex and parser must stay in sync with the daemon copy at
// packages/daemon/src/routes/todos.ts. The todo page merges daemon results
// with dirty tab overlays using the same parsing logic — any divergence will
// produce inconsistent states between saved and unsaved tabs.

const TODO_LINE_RE = /^(\s*)- \[([ xX])\]\s+(.*)$/;

export function parseTodosFromContent(content: string): TodoItem[] {
  const items: TodoItem[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(TODO_LINE_RE);
    if (match) {
      items.push({
        line: i + 1,
        text: match[3],
        checked: match[2].toLowerCase() === 'x',
      });
    }
  }
  return items;
}

/** Flip a single todo line in content string (returns new content). */
export function toggleTodoLine(content: string, line: number): string {
  const lines = content.split('\n');
  if (line < 1 || line > lines.length) return content;
  const match = lines[line - 1].match(TODO_LINE_RE);
  if (!match) return content;
  const [, indent, mark, text] = match;
  const newMark = mark.toLowerCase() === 'x' ? ' ' : 'x';
  lines[line - 1] = `${indent}- [${newMark}] ${text}`;
  return lines.join('\n');
}

/** Extract the first non-empty line as title — mirrors editor-store extractTitle. */
export function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  if (match) return match[1].trim();
  const firstLine = content.split('\n').find((l) => l.trim());
  return firstLine?.trim().slice(0, 30) || '无标题';
}
