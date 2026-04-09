import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useTagStore } from '@/stores/tag-store';
import { Check, Filter } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface TagFilterPopoverProps {
  activeTags: string[];
  onToggleTag: (tag: string) => void;
}

export function TagFilterPopover({ activeTags, onToggleTag }: TagFilterPopoverProps) {
  const { tags, fetchTags } = useTagStore();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      fetchTags();
      setSearch('');
      setHighlightIndex(-1);
    }
  }, [open, fetchTags]);

  const filtered = search
    ? tags.filter((t) => t.tagValue.toLowerCase().includes(search.toLowerCase()))
    : tags;

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setHighlightIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
    } else if (e.key === 'Enter' && highlightIndex >= 0 && highlightIndex < filtered.length) {
      e.preventDefault();
      onToggleTag(filtered[highlightIndex].tagValue);
    }
  };

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[data-tag-item]');
      items[highlightIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightIndex]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5">
          <Filter className="size-3.5" />
          标签筛选
          {activeTags.length > 0 && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              {activeTags.length}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <div className="p-2 border-b border-border">
          <Input
            placeholder="搜索标签..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-7 text-xs"
          />
        </div>
        <div ref={listRef} className="overflow-y-auto max-h-60">
          {filtered.length === 0 ? (
            <div className="p-3 text-center text-xs text-muted-foreground">无匹配标签</div>
          ) : (
            filtered.map((tag, index) => {
              const isActive = activeTags.includes(tag.tagValue);
              return (
                <button
                  key={tag.id}
                  type="button"
                  data-tag-item
                  onClick={() => onToggleTag(tag.tagValue)}
                  className={`flex items-center w-full px-3 py-1.5 text-xs transition-colors ${
                    index === highlightIndex ? 'bg-accent' : 'hover:bg-accent/50'
                  }`}
                >
                  <span className="flex-1 text-left">#{tag.tagValue}</span>
                  {isActive && <Check className="size-3.5 text-primary" />}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
