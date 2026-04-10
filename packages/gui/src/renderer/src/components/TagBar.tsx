import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DateTimePicker } from '@/components/DateTimePicker';
import { TagChip } from '@/components/TagChip';
import { Input } from '@/components/ui/input';
import type { NoteTag, Tag } from '@/lib/api';
import * as api from '@/lib/api';
import { formatDateISO } from '@/lib/date-format';
import { sortTags } from '@/lib/tag-sort';

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

function parseDateTimeHint(input: string): { date?: Date; time?: string } {
  const trimmed = input.trim();
  if (!trimmed) return {};

  // Split by space — first part is date, second is time (if both present)
  const parts = trimmed.split(/\s+/);
  let datePart = '';
  let timePart = '';

  if (parts.length >= 2) {
    datePart = parts[0];
    timePart = parts[1];
  } else if (parts[0].includes(':')) {
    // Only time (e.g., "15:00")
    timePart = parts[0];
  } else {
    // Only date
    datePart = parts[0];
  }

  const result: { date?: Date; time?: string } = {};
  const now = new Date();

  // Parse time (HH:MM or just HH)
  if (timePart) {
    const tParts = timePart.split(':').map(Number);
    if (tParts.length >= 1 && !Number.isNaN(tParts[0])) {
      const h = tParts[0];
      const m = tParts[1] ?? 0;
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        result.time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }
    }
  }

  // Parse date
  if (datePart) {
    // YYYYMMDD (e.g., 20260503)
    if (/^\d{8}$/.test(datePart)) {
      const y = Number(datePart.slice(0, 4));
      const mo = Number(datePart.slice(4, 6));
      const d = Number(datePart.slice(6, 8));
      const candidate = new Date(y, mo - 1, d);
      if (!Number.isNaN(candidate.getTime())) result.date = candidate;
    }
    // YYYY-MM-DD or YYYY.MM.DD
    else if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(datePart)) {
      const [y, mo, d] = datePart.split(/[-./]/).map(Number);
      const candidate = new Date(y, mo - 1, d);
      if (!Number.isNaN(candidate.getTime())) result.date = candidate;
    }
    // MM-DD or MM.DD or M-DD (e.g., 4-21, 3.15)
    else if (/^\d{1,2}[-./]\d{1,2}$/.test(datePart)) {
      const [mo, d] = datePart.split(/[-./]/).map(Number);
      let y = now.getFullYear();
      const candidate = new Date(y, mo - 1, d);
      if (candidate.getTime() < now.getTime()) y++;
      result.date = new Date(y, mo - 1, d);
    }
  }

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

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    };
  }, []);

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

    if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestions.length > 0) {
        handleEnterWithSuggestions();
      } else if (showFrequency) {
        handleEnterWithFrequency();
      } else {
        handleEnterDirect();
      }
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
    <div className="flex shrink-0 flex-col gap-1.5 border-t px-3 py-2" style={{ minHeight: 40 }}>
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
  );
}
