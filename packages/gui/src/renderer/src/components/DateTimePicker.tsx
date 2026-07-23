import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';

interface DateTimePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Element to position relative to */
  anchorRef: React.RefObject<HTMLElement | null>;
  initialDate?: Date;
  initialTime?: string;
  onConfirm: (date: Date) => void;
}

function formatTime(date: Date): string {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function DateTimePicker({
  open,
  onOpenChange,
  anchorRef,
  initialDate,
  initialTime,
  onConfirm,
}: DateTimePickerProps) {
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [timeValue, setTimeValue] = useState('00:00');
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      const base = initialDate ?? new Date();
      setSelectedDate(base);
      setTimeValue(initialTime ?? formatTime(base));
    }
  }, [open, initialDate, initialTime]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    }
    const timer = setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open, onOpenChange]);

  const handleConfirm = useCallback(() => {
    if (!selectedDate) return;
    const [hours, minutes] = timeValue.split(':').map(Number);
    const result = new Date(selectedDate);
    result.setHours(hours ?? 0, minutes ?? 0, 0, 0);
    onConfirm(result);
    onOpenChange(false);
  }, [selectedDate, timeValue, onConfirm, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onOpenChange(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        handleConfirm();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onOpenChange, handleConfirm]);

  if (!open) return null;

  const anchor = anchorRef.current;
  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 50,
  };
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    // ⚠️ REAL-DEVICE (Step 9): when the soft keyboard offsets the visual viewport
    // the anchor (floating TagBar) is itself `fixed`; `getBoundingClientRect` is
    // visual-viewport-relative while this `fixed` panel lays out against the
    // layout viewport, so add the offset back to keep the calendar in view. The
    // rig can't raise a keyboard (offsets are 0 → identical to before), so final
    // tuning is real-device feedback.
    const vv = window.visualViewport;
    const offsetLeft = vv?.offsetLeft ?? 0;
    const offsetTop = vv?.offsetTop ?? 0;
    style.left = rect.left + offsetLeft;
    style.bottom = window.innerHeight - (rect.top + offsetTop) + 4;
  }

  return (
    <div ref={panelRef} style={style} className="rounded-md border bg-popover shadow-md">
      <Calendar mode="single" selected={selectedDate} onSelect={setSelectedDate} />
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <span className="text-sm text-muted-foreground">时间</span>
        <Input
          type="time"
          value={timeValue}
          onChange={(e) => setTimeValue(e.target.value)}
          className="h-8 w-auto text-sm"
        />
      </div>
      <div className="flex justify-end gap-2 border-t px-3 py-2">
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button size="sm" onClick={handleConfirm} disabled={!selectedDate}>
          确认
        </Button>
      </div>
    </div>
  );
}

export { DateTimePicker };
export type { DateTimePickerProps };
