import { Button } from '@/components/ui/button';
import { formatShortcut, isModifierCode, shortcutFromEvent } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';

interface ShortcutRecorderProps {
  value: string;
  onChange: (next: string) => void;
}

export function ShortcutRecorder({ value, onChange }: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setRecording(false);
        return;
      }
      // Ignore lone modifier presses — wait for a real key.
      if (isModifierCode(e.code)) return;
      const next = shortcutFromEvent(e);
      if (next) {
        onChange(next);
        setRecording(false);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recording, onChange]);

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        'min-w-24 font-mono',
        recording && 'ring-2 ring-primary ring-offset-1 animate-pulse',
      )}
      onClick={() => setRecording((r) => !r)}
      onBlur={() => setRecording(false)}
    >
      {recording ? '按下组合键…' : formatShortcut(value)}
    </Button>
  );
}
