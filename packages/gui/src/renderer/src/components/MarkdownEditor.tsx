import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  type ViewUpdate,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  scrollPastEnd,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';
import { useEditorStore } from '../stores/editor-store';

// ─── Syntax highlight style (dark) ──────────────────────

const owlHighlightStyle = HighlightStyle.define([
  // Markdown structure
  { tag: tags.heading1, color: '#e2e8f0', fontWeight: 'bold', fontSize: '1.4em' },
  { tag: tags.heading2, color: '#e2e8f0', fontWeight: 'bold', fontSize: '1.2em' },
  { tag: tags.heading3, color: '#e2e8f0', fontWeight: 'bold', fontSize: '1.1em' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: '#cbd5e1', fontWeight: 'bold' },
  { tag: tags.strong, color: '#f8fafc', fontWeight: 'bold' },
  { tag: tags.emphasis, color: '#f8fafc', fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: '#94a3b8' },
  { tag: tags.link, color: '#60a5fa', textDecoration: 'underline' },
  { tag: tags.url, color: '#60a5fa' },
  { tag: tags.content, color: '#e2e8f0' },
  { tag: tags.quote, color: '#94a3b8', fontStyle: 'italic' },
  // Markdown markers: - * 1. > # ``` etc
  { tag: tags.list, color: '#f59e0b' },
  { tag: tags.meta, color: '#64748b' },
  { tag: [tags.processingInstruction, tags.monospace], color: '#a78bfa' },
  // Code block tokens (both language-specific and plain fenced blocks)
  { tag: tags.keyword, color: '#c084fc' },
  { tag: tags.string, color: '#86efac' },
  { tag: tags.number, color: '#fbbf24' },
  { tag: tags.comment, color: '#64748b', fontStyle: 'italic' },
  { tag: tags.variableName, color: '#67e8f9' },
  { tag: tags.function(tags.variableName), color: '#60a5fa' },
  { tag: tags.definition(tags.variableName), color: '#67e8f9' },
  { tag: tags.propertyName, color: '#67e8f9' },
  { tag: tags.typeName, color: '#fca5a5' },
  { tag: tags.className, color: '#fca5a5' },
  { tag: tags.operator, color: '#94a3b8' },
  { tag: tags.punctuation, color: '#94a3b8' },
  { tag: tags.bracket, color: '#94a3b8' },
  { tag: tags.bool, color: '#fbbf24' },
  { tag: tags.null, color: '#94a3b8' },
  { tag: tags.atom, color: '#fbbf24' },
  { tag: tags.labelName, color: '#fca5a5' },
  { tag: tags.attributeName, color: '#67e8f9' },
  { tag: tags.attributeValue, color: '#86efac' },
  { tag: tags.regexp, color: '#f59e0b' },
  { tag: tags.escape, color: '#f59e0b' },
  { tag: tags.self, color: '#c084fc' },
]);

// ─── Dark theme (editor chrome) ─────────────────────────

const owlDarkTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '14px',
      backgroundColor: 'oklch(0.145 0 0)',
      color: '#e2e8f0',
    },
    '.cm-content': {
      caretColor: '#e2e8f0',
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      padding: '8px 0',
    },
    '.cm-cursor': { borderLeftColor: '#e2e8f0' },
    '.cm-activeLine': { backgroundColor: 'oklch(0.3 0 0 / 0.5)' },
    '.cm-activeLineGutter': { backgroundColor: 'oklch(0.3 0 0 / 0.5)' },
    '.cm-gutters': {
      backgroundColor: 'oklch(0.145 0 0)',
      color: 'oklch(0.5 0 0)',
      borderRight: '1px solid oklch(0.269 0 0)',
    },
    '.cm-selectionBackground': { backgroundColor: '#4a72c4 !important' },
    '&.cm-focused .cm-selectionBackground': {
      backgroundColor: '#4a72c4 !important',
    },
    '& .cm-line ::selection': { backgroundColor: '#4a72c4 !important' },
    '& .cm-line::selection': { backgroundColor: '#4a72c4 !important' },
    '.cm-selectionMatch': { backgroundColor: '#26325C' },
    '.cm-searchMatch': { backgroundColor: 'oklch(0.5 0.15 80 / 0.3)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'oklch(0.5 0.15 80 / 0.5)' },
    '.cm-panels': {
      backgroundColor: 'oklch(0.18 0 0)',
      color: '#e2e8f0',
    },
    '.cm-panels input, .cm-panels button': {
      color: '#e2e8f0',
    },
  },
  { dark: true },
);

// ─── Markdown shortcuts (Cmd+B / Cmd+I) ────────────────

function wrapSelection(view: EditorView, marker: string): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    const wrapped = `${marker}${selected}${marker}`;
    return {
      changes: { from: range.from, to: range.to, insert: wrapped },
      range: EditorSelection.cursor(range.from + marker.length + selected.length),
    };
  });
  view.dispatch(changes);
  return true;
}

const markdownKeymap = keymap.of([
  { key: 'Mod-b', run: (view) => wrapSelection(view, '**') },
  { key: 'Mod-i', run: (view) => wrapSelection(view, '*') },
]);

// ─── List continuation ──────────────────────────────────

function continueList(view: EditorView): boolean {
  const { state } = view;
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const text = line.text;

  // Match unordered list: "  - " or "  * "
  const ulMatch = text.match(/^(\s*)([-*])\s(.*)$/);
  if (ulMatch) {
    const indent = ulMatch[1];
    const marker = ulMatch[2];
    const content = ulMatch[3];
    // Empty item → clear the marker
    if (!content.trim()) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: { anchor: line.from },
      });
      return true;
    }
    const prefix = `${indent}${marker} `;
    view.dispatch({
      changes: { from, to: from, insert: `\n${prefix}` },
      selection: { anchor: from + 1 + prefix.length },
    });
    return true;
  }

  // Match ordered list: "  1. content"
  const olMatch = text.match(/^(\s*)(\d+)\.\s(.*)$/);
  if (olMatch) {
    const indent = olMatch[1];
    const num = Number(olMatch[2]);
    const content = olMatch[3];
    // Empty item → clear the marker
    if (!content.trim()) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: { anchor: line.from },
      });
      return true;
    }
    const prefix = `${indent}${num + 1}. `;
    view.dispatch({
      changes: { from, to: from, insert: `\n${prefix}` },
      selection: { anchor: from + 1 + prefix.length },
    });
    return true;
  }

  return false;
}

const listContinuationKeymap = keymap.of([{ key: 'Enter', run: continueList }]);

// ─── Component ──────────────────────────────────────────

interface MarkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  className?: string;
}

export function MarkdownEditor({ value, onChange, className }: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapCompartmentRef = useRef<Compartment | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lineWrap = useEditorStore((s) => s.lineWrap);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only effect, value tracked via ref
  useEffect(() => {
    if (!containerRef.current) return;

    const wrapCompartment = new Compartment();
    wrapCompartmentRef.current = wrapCompartment;

    const extensions: Extension[] = [
      lineNumbers({ formatNumber: (n) => String(n).padStart(3, ' ') }),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      highlightSelectionMatches(),
      syntaxHighlighting(owlHighlightStyle),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      owlDarkTheme,
      markdownKeymap,
      listContinuationKeymap,
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) {
          onChangeRef.current?.(update.state.doc.toString());
        }
      }),
      wrapCompartment.of(useEditorStore.getState().lineWrap ? EditorView.lineWrapping : []),
      scrollPastEnd(),
    ];

    const state = EditorState.create({ doc: value, extensions });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Update content when value changes externally
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  // React to lineWrap toggle from the editor store via the compartment.
  useEffect(() => {
    const view = viewRef.current;
    const compartment = wrapCompartmentRef.current;
    if (!view || !compartment) return;
    view.dispatch({
      effects: compartment.reconfigure(lineWrap ? EditorView.lineWrapping : []),
    });
  }, [lineWrap]);

  return <div ref={containerRef} className={`h-full overflow-auto ${className ?? ''}`} />;
}
