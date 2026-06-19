import 'katex/dist/katex.min.css';

import { NoteIdPill } from '@/components/NoteIdPill';
import { remarkNoteRefs } from '@/lib/note-id-refs';
import { getPlatform } from '@/platform';
import { useMemo } from 'react';
import type { Components, Options, UrlTransform } from 'react-markdown';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

type RemarkPlugins = Options['remarkPlugins'];
type RehypePlugins = Options['rehypePlugins'];

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
  // On a networked thin client (web), the bearer token lives in JS, so a note
  // containing raw `<script>`/`<img onerror>` would steal it the moment it ran.
  // Drop `rehypeRaw` there: react-markdown then escapes raw HTML to text and it
  // is never parsed. The desktop is a local single-writer sandbox — it keeps
  // raw-HTML rendering unchanged.
  const remoteClient = getPlatform().remoteClient;

  const remarkPlugins = useMemo<RemarkPlugins>(
    () => (linkifyNoteIds ? [remarkGfm, remarkMath, remarkNoteRefs] : [remarkGfm, remarkMath]),
    [linkifyNoteIds],
  );

  const rehypePlugins = useMemo<RehypePlugins>(
    () =>
      remoteClient
        ? [rehypeKatex, rehypeHighlight]
        : [[rehypeRaw, { passThrough: ['math', 'inlineMath'] }], rehypeKatex, rehypeHighlight],
    [remoteClient],
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
        // `#` anchors scroll within the doc; everything else is an external
        // link opened in a new tab with `noopener`/`noreferrer` so the opened
        // page can't reach back via `window.opener`. `{...props}` is spread
        // FIRST so our controlled href/onClick/target/rel always win over any
        // attribute the desktop raw-HTML pipeline parsed off the source `<a>`.
        const isAnchor = href?.startsWith('#') ?? false;
        return (
          <a
            {...props}
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
              window.open(href, '_blank', 'noopener,noreferrer');
            }}
            {...(isAnchor ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
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
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={linkifyNoteIds ? noteAwareUrlTransform : undefined}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
