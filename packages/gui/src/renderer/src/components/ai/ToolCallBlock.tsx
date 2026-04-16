import type { ChatToolCall } from '@/stores/ai-store';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Wrench } from 'lucide-react';
import { useState } from 'react';

interface ToolCallBlockProps {
  call: ChatToolCall;
}

/**
 * Collapsible tool-call display. Defaults closed — for a chatty
 * agent that calls 5+ tools per turn, expanded-by-default would bury
 * the assistant text. Status comes in three flavours:
 *   • pending  → spinner, no result yet
 *   • success  → wrench icon, expand shows args + result
 *   • error    → triangle, expand defaults open so the user can read why
 */
export function ToolCallBlock({ call }: ToolCallBlockProps) {
  const isPending = call.result === undefined && !call.isError;
  // Auto-open on error so the user doesn't have to hunt for the cause.
  const [open, setOpen] = useState(call.isError === true);

  return (
    <div className="rounded-md border border-border bg-background text-xs overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-muted/40 text-left"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <StatusIcon pending={isPending} error={call.isError === true} />
        <span className="font-mono">{call.name}</span>
        {isPending && <span className="text-muted-foreground">运行中…</span>}
        {call.isError && <span className="text-destructive">出错</span>}
      </button>
      {open && (
        <div className="border-t border-border bg-muted/20 px-2 py-1.5 space-y-2">
          <Detail label="args" value={call.args} />
          {call.result !== undefined && <Detail label="result" value={call.result} />}
        </div>
      )}
    </div>
  );
}

function StatusIcon({ pending, error }: { pending: boolean; error: boolean }) {
  if (pending) return <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />;
  if (error) return <AlertTriangle className="size-3 shrink-0 text-destructive" />;
  return <Wrench className="size-3 shrink-0 text-muted-foreground" />;
}

function Detail({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
        {label}
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug bg-background rounded p-1.5 border border-border max-h-48 overflow-y-auto">
        {formatJson(value)}
      </pre>
    </div>
  );
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
