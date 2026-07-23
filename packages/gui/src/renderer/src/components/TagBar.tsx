import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DateTimePicker } from '@/components/DateTimePicker';
import { TagChip } from '@/components/TagChip';
import { Input } from '@/components/ui/input';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useKeyboardInset } from '@/hooks/useKeyboardInset';
import type { NoteTag, Tag } from '@/lib/api';
import * as api from '@/lib/api';
import { formatDateISO } from '@/lib/date-format';
import { sortTags } from '@/lib/tag-sort';
import { cn } from '@/lib/utils';

const FREQUENCY_OPTIONS = [
  { type: '/time', label: '/time (过期时间)', needsPicker: true },
  { type: '/alarm', label: '/alarm (提醒)', needsPicker: true },
  { type: '/daily', label: '/daily (每日)', needsPicker: false },
  { type: '/weekly', label: '/weekly (每周)', needsPicker: false },
  { type: '/monthly', label: '/monthly (每月)', needsPicker: false },
  { type: '/yearly', label: '/yearly (每年)', needsPicker: false },
] as const;

type TimeTagType = '/time' | '/alarm';

const UNIQUE_TYPES = new Set(['/time', '/daily', '/weekly', '/monthly', '/yearly']);

function makeTempId(): string {
  return `temp-${Date.now()}`;
}

function normalizeHashtagInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('#')) return trimmed.slice(1);
  return trimmed;
}

/** Split a hint into date + time tokens: two tokens = date then time; a lone `HH:MM` = time-only. */
function splitHintParts(trimmed: string): { datePart: string; timePart: string } {
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) return { datePart: parts[0], timePart: parts[1] };
  if (parts[0].includes(':')) return { datePart: '', timePart: parts[0] };
  return { datePart: parts[0], timePart: '' };
}

/** Parse an `HH[:MM]` hint into a zero-padded `HH:MM` string, or undefined when out of range / empty. */
function parseTimeHint(timePart: string): string | undefined {
  if (!timePart) return undefined;
  const tParts = timePart.split(':').map(Number);
  if (tParts.length >= 1 && !Number.isNaN(tParts[0])) {
    const h = tParts[0];
    const m = tParts[1] ?? 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }
  return undefined;
}

/** Parse a date hint (YYYYMMDD / YYYY-MM-DD / MM-DD, `-./` separators); MM-DD rolls to next year if already past. */
function parseDateHint(datePart: string, now: Date): Date | undefined {
  if (!datePart) return undefined;

  // YYYYMMDD (e.g., 20260503)
  if (/^\d{8}$/.test(datePart)) {
    const y = Number(datePart.slice(0, 4));
    const mo = Number(datePart.slice(4, 6));
    const d = Number(datePart.slice(6, 8));
    const candidate = new Date(y, mo - 1, d);
    return Number.isNaN(candidate.getTime()) ? undefined : candidate;
  }
  // YYYY-MM-DD or YYYY.MM.DD
  if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(datePart)) {
    const [y, mo, d] = datePart.split(/[-./]/).map(Number);
    const candidate = new Date(y, mo - 1, d);
    return Number.isNaN(candidate.getTime()) ? undefined : candidate;
  }
  // MM-DD or MM.DD or M-DD (e.g., 4-21, 3.15)
  if (/^\d{1,2}[-./]\d{1,2}$/.test(datePart)) {
    const [mo, d] = datePart.split(/[-./]/).map(Number);
    let y = now.getFullYear();
    const candidate = new Date(y, mo - 1, d);
    if (candidate.getTime() < now.getTime()) y++;
    return new Date(y, mo - 1, d);
  }

  return undefined;
}

function parseDateTimeHint(input: string): { date?: Date; time?: string } {
  const trimmed = input.trim();
  if (!trimmed) return {};

  const { datePart, timePart } = splitHintParts(trimmed);
  const now = new Date();

  const result: { date?: Date; time?: string } = {};
  const time = parseTimeHint(timePart);
  if (time !== undefined) result.time = time;
  const date = parseDateHint(datePart, now);
  if (date !== undefined) result.date = date;
  return result;
}

interface TagBarProps {
  tags: NoteTag[];
  onTagsChange: (tags: NoteTag[]) => void;
}

export function TagBar({ tags, onTagsChange }: TagBarProps) {
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<Tag[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showFrequency, setShowFrequency] = useState(false);
  const [hasNavigated, setHasNavigated] = useState(false);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTagType, setPickerTagType] = useState<TimeTagType>('/time');
  const [pickerInitialDate, setPickerInitialDate] = useState<Date | undefined>(undefined);
  const [pickerInitialTime, setPickerInitialTime] = useState<string | undefined>(undefined);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);

  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);

  // Step 9 (§4.2): on mobile, ride the soft keyboard — when a field is focused
  // and the keyboard lifts, `position: fixed; bottom: <inset>` keeps the bar
  // visible above it. A ResizeObserver-measured in-flow placeholder reserves the
  // bar's height so the editor content above doesn't collapse/jump. When there's
  // no keyboard (inset 0, desktop, no visualViewport) it's a normal in-flow bar.
  const isMobile = useIsMobile();
  const inset = useKeyboardInset();
  const floating = isMobile && inset > 0;
  const barRef = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState(0);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!floating) {
      setBarHeight(0);
      return;
    }
    const el = barRef.current;
    if (!el) return;
    const measure = () => setBarHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [floating]);

  useEffect(() => {
    const trimmed = input.trim();
    if (!trimmed || trimmed.startsWith('/')) {
      setSuggestions([]);
      return;
    }
    const query = normalizeHashtagInput(trimmed);
    if (!query) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      api.listTags(query).then((res) => {
        if (cancelled) return;
        const existing = new Set(tags.filter((t) => t.tagType === '#').map((t) => t.tagValue));
        const filtered = (res.data ?? []).filter(
          (t) => t.tagType === '#' && !existing.has(t.tagValue),
        );
        setSuggestions(filtered);
        setSelectedIndex(0);
        setHasNavigated(false);
      });
    }, 200);
    setShowFrequency(false);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [input, tags]);

  const filteredFrequency = useMemo(() => {
    if (!input.startsWith('/')) return [];
    const q = input.toLowerCase();
    return FREQUENCY_OPTIONS.filter(
      (o) => o.type.startsWith(q) || o.label.toLowerCase().includes(q),
    );
  }, [input]);

  useEffect(() => {
    if (input.startsWith('/')) {
      setShowFrequency(filteredFrequency.length > 0);
      setSuggestions([]);
      setSelectedIndex(0);
      setHasNavigated(false);
    } else {
      setShowFrequency(false);
    }
  }, [input, filteredFrequency]);

  const addTag = useCallback(
    (tagType: string, tagValue: string | null) => {
      const newTag: NoteTag = { id: makeTempId(), tagType, tagValue };
      if (UNIQUE_TYPES.has(tagType)) {
        const filtered = tags.filter((t) => t.tagType !== tagType);
        onTagsChange([...filtered, newTag]);
      } else {
        if (tags.some((t) => t.tagType === tagType && t.tagValue === tagValue)) return;
        onTagsChange([...tags, newTag]);
      }
    },
    [tags, onTagsChange],
  );

  const removeTag = useCallback(
    (id: string) => {
      onTagsChange(tags.filter((t) => t.id !== id));
    },
    [tags, onTagsChange],
  );

  const updateTag = useCallback(
    (id: string, tagValue: string | null) => {
      onTagsChange(tags.map((t) => (t.id === id ? { ...t, tagValue } : t)));
    },
    [tags, onTagsChange],
  );

  function openPickerForNew(type: TimeTagType, dateHint?: string) {
    setPickerTagType(type);
    setEditingTagId(null);

    if (dateHint) {
      const hint = parseDateTimeHint(dateHint);
      setPickerInitialDate(hint.date);
      setPickerInitialTime(hint.time);
    } else {
      setPickerInitialDate(undefined);
      setPickerInitialTime(undefined);
    }
    setPickerOpen(true);
  }

  function openPickerForEdit(tag: NoteTag) {
    if (tag.tagType !== '/time' && tag.tagType !== '/alarm') return;
    setPickerTagType(tag.tagType as TimeTagType);
    setPickerInitialDate(tag.tagValue ? new Date(tag.tagValue) : undefined);
    setPickerInitialTime(undefined);
    setEditingTagId(tag.id);
    setPickerOpen(true);
  }

  function handlePickerConfirm(date: Date) {
    const iso = formatDateISO(date);
    if (editingTagId) {
      if (tags.some((t) => t.id === editingTagId)) {
        updateTag(editingTagId, iso);
      } else {
        addTag(pickerTagType, iso);
      }
    } else {
      addTag(pickerTagType, iso);
    }
    setEditingTagId(null);
    setInput('');
  }

  function handleArrowKey(key: string) {
    const maxIndex =
      suggestions.length > 0
        ? suggestions.length - 1
        : showFrequency
          ? filteredFrequency.length - 1
          : -1;
    if (maxIndex < 0) return;

    setHasNavigated(true);
    if (key === 'ArrowDown') {
      setSelectedIndex((i) => Math.min(i + 1, maxIndex));
    } else {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
  }

  function handleEnterWithSuggestions() {
    if (hasNavigated) {
      const tag = suggestions[selectedIndex];
      if (tag) {
        addTag(tag.tagType, tag.tagValue);
        setInput('');
        setSuggestions([]);
        return;
      }
    }
    addHashtagDirect();
  }

  function handleEnterWithFrequency() {
    const opt = filteredFrequency[selectedIndex];
    if (!opt) return;
    if (opt.needsPicker) {
      openPickerForNew(opt.type as TimeTagType);
    } else {
      addTag(opt.type, null);
    }
    setInput('');
    setShowFrequency(false);
  }

  function addHashtagDirect() {
    const value = normalizeHashtagInput(input);
    if (value) {
      addTag('#', value);
    }
    setInput('');
    setSuggestions([]);
  }

  function handleEnterDirect() {
    const trimmed = input.trim();
    if (!trimmed) return;

    const freqMatch = FREQUENCY_OPTIONS.find((o) => o.type === trimmed);
    if (freqMatch) {
      if (freqMatch.needsPicker) {
        openPickerForNew(freqMatch.type as TimeTagType);
      } else {
        addTag(freqMatch.type, null);
      }
      setInput('');
      return;
    }

    if (trimmed.startsWith('/time') || trimmed.startsWith('/alarm')) {
      const isAlarm = trimmed.startsWith('/alarm');
      const type: TimeTagType = isAlarm ? '/alarm' : '/time';
      const dateHint = trimmed.slice(isAlarm ? 6 : 5).trim();
      openPickerForNew(type, dateHint || undefined);
      setInput('');
      return;
    }

    addHashtagDirect();
  }

  function completeSuggestion(): boolean {
    const tag = suggestions[selectedIndex] ?? suggestions[0];
    if (!tag) return false;
    setInput(`#${tag.tagValue}`);
    setSuggestions([]);
    setHasNavigated(false);
    return true;
  }

  function completeFrequency(): boolean {
    const opt = filteredFrequency[selectedIndex] ?? filteredFrequency[0];
    if (!opt) return false;
    const needsArg = opt.type === '/time' || opt.type === '/alarm';
    setInput(needsArg ? `${opt.type} ` : opt.type);
    setShowFrequency(false);
    setHasNavigated(false);
    return true;
  }

  function handleTabComplete(): boolean {
    if (suggestions.length > 0) return completeSuggestion();
    if (showFrequency && filteredFrequency.length > 0) return completeFrequency();
    return false;
  }

  function handleEnter() {
    if (suggestions.length > 0) {
      handleEnterWithSuggestions();
    } else if (showFrequency) {
      handleEnterWithFrequency();
    } else {
      handleEnterDirect();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (pickerOpen) return;

    if (e.key === 'Escape') {
      setSuggestions([]);
      setShowFrequency(false);
      setInput('');
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      handleArrowKey(e.key);
      return;
    }

    if (e.key === 'Tab' && !e.shiftKey) {
      if (handleTabComplete()) {
        e.preventDefault();
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      handleEnter();
    }
  }

  function handleBlur() {
    blurTimerRef.current = setTimeout(() => {
      setSuggestions([]);
      setShowFrequency(false);
    }, 150);
  }

  function handleFocus() {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    if (input.startsWith('/')) setShowFrequency(true);
  }

  function handleSuggestionClick(tag: Tag) {
    addTag(tag.tagType, tag.tagValue);
    setInput('');
    setSuggestions([]);
  }

  function handleFrequencyClick(opt: (typeof FREQUENCY_OPTIONS)[number]) {
    if (opt.needsPicker) {
      openPickerForNew(opt.type as TimeTagType);
    } else {
      addTag(opt.type, null);
    }
    setInput('');
    setShowFrequency(false);
  }

  const sorted = sortTags(tags);

  return (
    <>
      {/* In-flow placeholder: lifting the bar to `fixed` would otherwise let the
          keyboard cover the editor's last lines / collapse the column. */}
      {floating && <div aria-hidden style={{ height: barHeight }} />}
      <div
        ref={barRef}
        className={cn(
          'flex shrink-0 flex-col gap-1.5 border-t px-3 py-2',
          // `fixed` needs a transform-free ancestor chain (the mobile editor
          // shell is plain flex, so it is). bg-background keeps it opaque over
          // the content it now overlaps.
          floating && 'fixed inset-x-0 z-40 bg-background',
        )}
        style={floating ? { minHeight: 40, bottom: inset } : { minHeight: 40 }}
      >
        <div ref={inputContainerRef} className="relative">
          <Input
            data-tag-input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            onFocus={handleFocus}
            placeholder="输入标签..."
            className="h-7 border-none bg-transparent text-xs shadow-none focus-visible:ring-0"
          />

          <DateTimePicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            anchorRef={inputContainerRef}
            initialDate={pickerInitialDate}
            initialTime={pickerInitialTime}
            onConfirm={handlePickerConfirm}
          />

          {suggestions.length > 0 && (
            <div className="absolute bottom-full left-0 z-50 mb-1 max-h-48 w-56 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
              {suggestions.map((tag, i) => (
                <button
                  key={tag.id}
                  type="button"
                  className={`flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-xs ${
                    i === selectedIndex && hasNavigated
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50'
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSuggestionClick(tag);
                  }}
                >
                  #{tag.tagValue}
                </button>
              ))}
            </div>
          )}

          {showFrequency && (
            <div className="absolute bottom-full left-0 z-50 mb-1 w-56 rounded-md border bg-popover p-1 shadow-md">
              {filteredFrequency.map((opt, i) => (
                <button
                  key={opt.type}
                  type="button"
                  className={`flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-xs ${
                    i === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleFrequencyClick(opt);
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {sorted.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {sorted.map((tag) => (
              <TagChip
                key={tag.id}
                tag={tag}
                onDelete={() => removeTag(tag.id)}
                onClick={
                  tag.tagType === '/time' || tag.tagType === '/alarm'
                    ? () => openPickerForEdit(tag)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
