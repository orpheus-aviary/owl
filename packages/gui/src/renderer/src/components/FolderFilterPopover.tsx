import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Folder } from '@/lib/api';
import { type FolderNode, buildFolderTree, useFolderStore } from '@/stores/folder-store';
import { Check, FolderOpen, Inbox } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

interface FolderFilterPopoverProps {
  activeFolderId: string | undefined;
  onSelect: (id: string | undefined) => void;
}

/** Build the full ancestor path string for a folder, e.g. "Root / Parent / Child". */
function getFolderPath(folders: Folder[], id: string): string {
  const parts: string[] = [];
  let cur: Folder | undefined = folders.find((f) => f.id === id);
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parent_id ? folders.find((f) => f.id === cur?.parent_id) : undefined;
  }
  return parts.join(' / ');
}

/** Flatten a tree into a flat id list in DFS order (for keyboard navigation). */
function flattenTree(nodes: FolderNode[]): string[] {
  const result: string[] = [];
  for (const n of nodes) {
    result.push(n.id);
    if (n.children.length > 0) result.push(...flattenTree(n.children));
  }
  return result;
}

export function FolderFilterPopover({ activeFolderId, onSelect }: FolderFilterPopoverProps) {
  const { folders, fetch } = useFolderStore();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      fetch();
      setSearch('');
      setHighlightIndex(-1);
    }
  }, [open, fetch]);

  const tree = useMemo(() => buildFolderTree(folders), [folders]);

  const filtered = useMemo(() => {
    if (!search) return null;
    const q = search.toLowerCase();
    return folders.filter((f) => f.name.toLowerCase().includes(q));
  }, [folders, search]);

  // Build flat option list: [undefined (all), ...folder ids]
  // Used for keyboard navigation index mapping
  const flatOptions = useMemo(() => {
    const ids: (string | undefined)[] = [undefined]; // "全部笔记"
    if (filtered) {
      for (const f of filtered) ids.push(f.id);
    } else {
      ids.push(...flattenTree(tree));
    }
    return ids;
  }, [filtered, tree]);

  const handleSelect = (id: string | undefined) => {
    onSelect(id);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((prev) => (prev < flatOptions.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((prev) => (prev > 0 ? prev - 1 : flatOptions.length - 1));
    } else if (e.key === 'Enter' && highlightIndex >= 0 && highlightIndex < flatOptions.length) {
      e.preventDefault();
      handleSelect(flatOptions[highlightIndex]);
    }
  };

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[data-folder-item]');
      items[highlightIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightIndex]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setHighlightIndex(-1);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5">
          <FolderOpen className="size-3.5" />
          文件夹
          {activeFolderId && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              1
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <div className="p-2 border-b border-border">
          <Input
            placeholder="搜索文件夹..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-7 text-xs"
          />
        </div>
        <div ref={listRef} className="overflow-y-auto max-h-60">
          {/* "All notes" option — always visible, index 0 */}
          <button
            type="button"
            data-folder-item
            onClick={() => handleSelect(undefined)}
            className={`flex items-center w-full px-3 py-1.5 text-xs transition-colors ${
              highlightIndex === 0 ? 'bg-accent' : 'hover:bg-accent/50'
            }`}
          >
            <Inbox className="size-3.5 mr-2 text-muted-foreground" />
            <span className="flex-1 text-left">全部笔记</span>
            {activeFolderId === undefined && <Check className="size-3.5 text-primary" />}
          </button>

          {filtered ? (
            /* Search mode — flat list with full path */
            filtered.length === 0 ? (
              <div className="p-3 text-center text-xs text-muted-foreground">无匹配文件夹</div>
            ) : (
              filtered.map((f, i) => (
                <button
                  key={f.id}
                  type="button"
                  data-folder-item
                  onClick={() => handleSelect(f.id)}
                  className={`flex items-center w-full py-1.5 pr-3 pl-3 text-xs transition-colors ${
                    highlightIndex === i + 1
                      ? 'bg-accent'
                      : f.id === activeFolderId
                        ? 'bg-accent/50'
                        : 'hover:bg-accent/50'
                  }`}
                >
                  <FolderOpen className="size-3.5 mr-2 text-muted-foreground shrink-0" />
                  <div className="flex-1 text-left min-w-0">
                    <span className="truncate">{f.name}</span>
                    <span className="text-muted-foreground text-[10px] ml-1">
                      ({getFolderPath(folders, f.id)})
                    </span>
                  </div>
                  {f.id === activeFolderId && <Check className="size-3.5 text-primary shrink-0" />}
                </button>
              ))
            )
          ) : /* Tree mode — normal hierarchical display */
          tree.length === 0 ? (
            <div className="p-3 text-center text-xs text-muted-foreground">暂无文件夹</div>
          ) : (
            <FolderNodes
              nodes={tree}
              depth={0}
              activeFolderId={activeFolderId}
              highlightId={highlightIndex > 0 ? (flatOptions[highlightIndex] as string) : undefined}
              onSelect={handleSelect}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FolderNodes({
  nodes,
  depth,
  activeFolderId,
  highlightId,
  onSelect,
}: {
  nodes: FolderNode[];
  depth: number;
  activeFolderId: string | undefined;
  highlightId: string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.id}>
          <button
            type="button"
            data-folder-item
            onClick={() => onSelect(node.id)}
            className={`flex items-center w-full py-1.5 pr-3 text-xs transition-colors ${
              node.id === highlightId
                ? 'bg-accent'
                : node.id === activeFolderId
                  ? 'bg-accent/50'
                  : 'hover:bg-accent/50'
            }`}
            style={{ paddingLeft: `${12 + depth * 16}px` }}
          >
            <FolderOpen className="size-3.5 mr-2 text-muted-foreground shrink-0" />
            <span className="flex-1 text-left truncate">{node.name}</span>
            {node.id === activeFolderId && <Check className="size-3.5 text-primary shrink-0" />}
          </button>
          {node.children.length > 0 && (
            <FolderNodes
              nodes={node.children}
              depth={depth + 1}
              activeFolderId={activeFolderId}
              highlightId={highlightId}
              onSelect={onSelect}
            />
          )}
        </div>
      ))}
    </>
  );
}
