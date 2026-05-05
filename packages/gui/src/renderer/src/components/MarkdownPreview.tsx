import 'katex/dist/katex.min.css';

import { NoteIdPill } from '@/components/NoteIdPill';
import { remarkNoteRefs } from '@/lib/note-id-refs';
import { useMemo } from 'react';
import type { Components, Options, UrlTransform } from 'react-markdown';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

type RemarkPlugins = Options['remarkPlugins'];

/**
 * react-markdown's default URL sanitizer rewrites any unknown protocol to
 * `""`, which strips our `note:<uuid>` hrefs before the `<a>` override
 * sees them. Let `note:` through verbatim, delegate everything else.
 */
const noteAwareUrlTransform: UrlTransform = (url, _key, _node) => {
  if (url.startsWith('note:')) return url;
  return defaultUrlTransform(url);
};

interface MarkdownPreviewProps {
  content: string;
  className?: string;
  /**
   * When `true`, bare note UUIDs in plain text nodes are rewritten into
   * `[<uuid>](note:<uuid>)` links (via `remarkNoteRefs`) and the `<a>`
   * handler renders them as `<NoteIdPill>`. Off by default so the
   * editor's own preview of user-authored notes never pill-ifies a UUID
   * the user typed intentionally. Turn on only for AI chat messages.
   */
  linkifyNoteIds?: boolean;
}

export function MarkdownPreview({
  content,
  className,
  linkifyNoteIds = false,
}: MarkdownPreviewProps) {
  const remarkPlugins = useMemo<RemarkPlugins>(
    () => (linkifyNoteIds ? [remarkGfm, remarkMath, remarkNoteRefs] : [remarkGfm, remarkMath]),
    [linkifyNoteIds],
  );

  const components = useMemo<Components>(
    () => ({
      // Wrap tables in a scrollable container
      table: ({ children, ...props }) => (
        <div className="table-wrapper">
          <table {...props}>{children}</table>
        </div>
      ),
      // Handle links: external → system browser, anchors → scrollIntoView,
      // note: scheme (only when linkifyNoteIds is on) → pill.
      a: ({ href, children, ...props }) => {
        if (linkifyNoteIds && href?.startsWith('note:')) {
          return <NoteIdPill id={href.slice('note:'.length)} />;
        }
        return (
          <a
            href={href}
            onClick={(e) => {
              if (!href) return;
              if (href.startsWith('#')) {
                e.preventDefault();
                const id = href.slice(1);
                const el = document.getElementById(id);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                return;
              }
              e.preventDefault();
              window.open(href, '_blank');
            }}
            {...props}
          >
            {children}
          </a>
        );
      },
    }),
    [linkifyNoteIds],
  );

  return (
    <div
      className={`markdown-preview h-full overflow-y-auto overflow-x-hidden p-6 ${className ?? ''}`}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[
          [rehypeRaw, { passThrough: ['math', 'inlineMath'] }],
          rehypeKatex,
          rehypeHighlight,
        ]}
        components={components}
        urlTransform={linkifyNoteIds ? noteAwareUrlTransform : undefined}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
