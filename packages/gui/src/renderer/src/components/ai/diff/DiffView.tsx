import { useIsMobile } from '@/hooks/useIsMobile';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';

export interface DiffViewProps {
  /** Left pane content — typically the user's local / baseline version. */
  original: string;
  /** Right pane content — typically the AI's proposed version. */
  modified: string;
  /** Optional column headers; rendered in a small strip above each pane. */
  originalLabel?: string;
  modifiedLabel?: string;
  /** Extra className applied to the container (passes through from parent). */
  className?: string;
}

/**
 * Read-only split-view diff powered by `@codemirror/merge`. Both panes
 * render markdown with line numbers and are non-editable; the user's
 * choice ("accept AI" / "keep mine") lives on the parent dialog, not on
 * the diff itself.
 *
 * The view is torn down + rebuilt when `original` or `modified` change
 * identity. Diffs aren't large enough for incremental patching to be
 * worth the complexity — full rebuild is <5ms on realistic note sizes.
 */
export function DiffView({
  original,
  modified,
  originalLabel = '本地版本',
  modifiedLabel = 'AI 版本',
  className,
}: DiffViewProps) {
  const isMobile = useIsMobile();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MergeView | null>(null);

  useEffect(() => {
    const parent = containerRef.current;
    // Mobile web (§4.5): no side-by-side MergeView — the stacked read-only
    // fallback below renders instead, so never instantiate the editor here.
    if (!parent || isMobile) return;

    const baseExtensions = [
      lineNumbers(),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
      diffTheme,
    ];

    const view = new MergeView({
      a: { doc: original, extensions: baseExtensions },
      b: { doc: modified, extensions: baseExtensions },
      parent,
      orientation: 'a-b',
      highlightChanges: true,
      gutter: true,
      // Reverts aren't meaningful here — the accept/reject decision is
      // made at the dialog level, not chunk-by-chunk.
      revertControls: undefined,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [original, modified, isMobile]);

  // Mobile: two stacked read-only panes (no MergeView — it's unreadable at
  // phone width). The accept/reject decision still lives on the parent dialog.
  if (isMobile) {
    return (
      <div className={`flex flex-col min-h-0 overflow-auto ${className ?? ''}`}>
        <DiffPane label={originalLabel} text={original} />
        <DiffPane label={modifiedLabel} text={modified} />
      </div>
    );
  }

  return (
    <div className={`flex flex-col min-h-0 ${className ?? ''}`}>
      <div className="flex text-[11px] text-muted-foreground border-b border-border">
        <div className="flex-1 px-3 py-1 border-r border-border">{originalLabel}</div>
        <div className="flex-1 px-3 py-1">{modifiedLabel}</div>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 overflow-auto" />
    </div>
  );
}

/** One stacked read-only pane of the mobile diff fallback. */
function DiffPane({ label, text }: { label: string; text: string }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="sticky top-0 bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
        {label}
      </div>
      <pre className="whitespace-pre-wrap break-words px-3 py-2 text-xs text-foreground">
        {text}
      </pre>
    </div>
  );
}

/**
 * Minimal visual tuning to match the editor's dark theme. The merge
 * package ships functional styles (diff highlights, gutters); we only
 * override colors + sizing so the view doesn't stand out from the rest
 * of the dialog chrome.
 */
const diffTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '13px',
    },
    '.cm-mergeView': {
      height: '100%',
    },
    '.cm-mergeViewEditors': {
      height: '100%',
    },
    '.cm-editor': {
      height: '100%',
    },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    },
    '.cm-changedLine': {
      backgroundColor: 'oklch(0.5 0.15 80 / 0.12)',
    },
    '.cm-changedText': {
      backgroundColor: 'oklch(0.5 0.15 80 / 0.3)',
    },
    '.cm-deletedChunk': {
      backgroundColor: 'oklch(0.5 0.18 20 / 0.12)',
    },
    '.cm-insertedLine': {
      backgroundColor: 'oklch(0.55 0.14 140 / 0.12)',
    },
  },
  { dark: true },
);
