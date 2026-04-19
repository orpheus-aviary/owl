import { cn } from '@/lib/utils';
import { Separator } from 'react-resizable-panels';

interface ResizeHandleProps {
  id?: string;
  className?: string;
  disabled?: boolean;
}

export function ResizeHandle({ id, className, disabled }: ResizeHandleProps) {
  return (
    <Separator
      id={id}
      disabled={disabled}
      className={cn(
        'relative w-px shrink-0 bg-border transition-colors',
        'hover:bg-sidebar-primary/60 data-[separator-drag]:bg-sidebar-primary',
        className,
      )}
    />
  );
}
