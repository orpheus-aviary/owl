/**
 * W7 §3.5 — hand-merge modal for one conflict.
 *
 * Desktop: a `@codemirror/merge` MergeView. Left pane (`a`) = the local (losing)
 * copy, read-only. Right pane (`b`) = the final result, seeded with the remote
 * (winning) copy and editable. The revert gutter runs local → result so the user
 * can pull chunks from their local copy into the merged output. Submitting saves
 * the right pane's text through the `merged` strategy.
 *
 * The MergeView is constructed in a **callback ref**, not a `useEffect`: the
 * dialog renders through a radix Portal whose container attaches *after* this
 * component's effects run, so an effect would see a null container and never
 * mount the editor. A callback ref fires exactly when the node is committed.
 *
 * Mobile web (§4.5): the side-by-side MergeView is unreadable at phone width, so
 * the fallback is a stacked read-only 本地副本 over a single-column「最终结果」
 * textarea (seeded remote). No MergeView is instantiated. Buttons: 取消 /
 * 采用本地副本 (resolveConflict('local')) / 保存合并结果 (merged).
 */

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useIsMobile } from '@/hooks/useIsMobile';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { useCallback, useRef, useState } from 'react';

export interface ConflictMergeDialogProps {
  open: boolean;
  /** Local (losing) copy — read-only left pane. */
  localContent: string;
  /** Remote (winning) copy — seeds the editable result pane. */
  remoteContent: string;
  /** Disable the confirm button while the resolve request is in flight. */
  submitting?: boolean;
  /** Surfaced beneath the editor (e.g. stale-baseline 409). */
  error?: string | null;
  onCancel: () => void;
  /** Receives the final merged text (right pane). */
  onSubmit: (mergedContent: string) => void;
  /**
   * Mobile only — adopt the local copy wholesale (resolveConflict('local')). On
   * desktop this action lives on the conflict row (「用本地覆盖」), so it's unset.
   */
  onResolveLocal?: () => void;
}

export function ConflictMergeDialog(props: ConflictMergeDialogProps) {
  const isMobile = useIsMobile();
  return (
    <Dialog open={props.open} onOpenChange={(next) => !next && props.onCancel()}>
      {isMobile ? <MobileMergeContent {...props} /> : <DesktopMergeContent {...props} />}
    </Dialog>
  );
}

function DesktopMergeContent({
  localContent,
  remoteContent,
  submitting = false,
  error,
  onCancel,
  onSubmit,
}: ConflictMergeDialogProps) {
  const viewRef = useRef<MergeView | null>(null);

  // Callback ref: build the MergeView when the container attaches, tear it down
  // when it detaches. The dialog remounts per conflict, so localContent /
  // remoteContent are stable for the view's lifetime — no rebuild-on-change.
  const setContainer = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        viewRef.current?.destroy();
        viewRef.current = null;
        return;
      }
      if (viewRef.current) return; // already built

      const sharedTheme = [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        mergeTheme,
      ];
      const leftExtensions = [
        lineNumbers(),
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        ...sharedTheme,
      ];
      const rightExtensions = [lineNumbers(), EditorView.lineWrapping, ...sharedTheme];

      const view = new MergeView({
        a: { doc: localContent, extensions: leftExtensions },
        b: { doc: remoteContent, extensions: rightExtensions },
        parent: node,
        orientation: 'a-b',
        highlightChanges: true,
        gutter: true,
        // Revert gutter runs local (a) → result (b): the user can pull their
        // local chunks into the editable result. b → a is meaningless (a is
        // read-only).
        revertControls: 'a-to-b',
      });
      viewRef.current = view;
      // The dialog animates in (scale/opacity); re-measure once painted so the
      // panes aren't blank until the first scroll/keystroke.
      requestAnimationFrame(() => {
        view.a.requestMeasure();
        view.b.requestMeasure();
      });
    },
    [localContent, remoteContent],
  );

  const handleConfirm = () => {
    const merged = viewRef.current?.b.state.doc.toString() ?? remoteContent;
    onSubmit(merged);
  };

  return (
    <DialogContent className="sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle>手动处理冲突</DialogTitle>
        <DialogDescription>
          左侧为本地副本（只读），右侧为最终结果（可编辑，初始为远端胜出版本）。用中间的箭头把本地内容并入结果，编辑满意后保存。
        </DialogDescription>
      </DialogHeader>
      <div className="overflow-hidden rounded-md border border-border">
        <div className="flex border-b border-border text-[11px] text-muted-foreground">
          <div className="flex-1 border-r border-border px-3 py-1">本地副本（只读）</div>
          <div className="flex-1 px-3 py-1">最终结果（可编辑）</div>
        </div>
        {/* Content-height editors + a scrolling container: no dependency on a
            `height: 100%` cascade (which collapses to 0 inside the portal). */}
        <div
          ref={setContainer}
          className="overflow-auto"
          style={{ minHeight: '12rem', maxHeight: '55vh' }}
        />
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button onClick={handleConfirm} disabled={submitting}>
          {submitting ? '保存中…' : '保存合并结果'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function MobileMergeContent({
  localContent,
  remoteContent,
  submitting = false,
  error,
  onCancel,
  onSubmit,
  onResolveLocal,
}: ConflictMergeDialogProps) {
  // Seed the result with the remote (winning) copy, like the desktop right pane.
  // The dialog remounts per conflict, so a fresh mount reseeds.
  const [draft, setDraft] = useState(remoteContent);

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>手动处理冲突</DialogTitle>
        <DialogDescription>
          上方为本地副本（只读），下方为最终结果（初始为远端胜出版本，可编辑）。编辑满意后保存，或直接采用本地副本。
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <div className="text-[11px] text-muted-foreground">本地副本（只读）</div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-xs text-foreground">
          {localContent || '(无副本)'}
        </pre>
        <div className="text-[11px] text-muted-foreground">最终结果（可编辑）</div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="max-h-[40vh] min-h-[8rem] w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}
      <DialogFooter className="gap-2 sm:gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        {onResolveLocal && (
          <Button variant="outline" onClick={onResolveLocal} disabled={submitting}>
            采用本地副本
          </Button>
        )}
        <Button onClick={() => onSubmit(draft)} disabled={submitting}>
          {submitting ? '保存中…' : '保存合并结果'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * Match the AI DiffView's palette (theme-neutral oklch highlights) so the merge
 * view blends with the rest of the editor chrome.
 */
const mergeTheme = EditorView.theme(
  {
    // No `height: 100%` — the editors size to their content and the container
    // (min/max-height + overflow-auto) does the scrolling.
    // Background / gutter match MarkdownEditor's dark palette so the merge view
    // doesn't flash a white line-number gutter against the app chrome.
    '&': { fontSize: '13px', backgroundColor: 'oklch(0.145 0 0)', color: '#e2e8f0' },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    },
    '.cm-gutters': {
      backgroundColor: 'oklch(0.145 0 0)',
      color: 'oklch(0.5 0 0)',
      borderRight: '1px solid oklch(0.269 0 0)',
    },
    // The middle revert-arrow gutter + alignment spacers default to a light
    // fill; match the dark editor body.
    '.cm-merge-revert': { backgroundColor: 'oklch(0.145 0 0)' },
    '.cm-mergeSpacer': { backgroundColor: 'oklch(0.145 0 0)' },
    '.cm-changedLine': { backgroundColor: 'oklch(0.5 0.15 80 / 0.12)' },
    '.cm-changedText': { backgroundColor: 'oklch(0.5 0.15 80 / 0.3)' },
    '.cm-deletedChunk': { backgroundColor: 'oklch(0.5 0.18 20 / 0.12)' },
    '.cm-insertedLine': { backgroundColor: 'oklch(0.55 0.14 140 / 0.12)' },
  },
  { dark: true },
);
