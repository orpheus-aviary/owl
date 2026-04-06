import 'katex/dist/katex.min.css';

import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

// Custom components for markdown rendering
const components: Components = {
  // Wrap tables in a scrollable container
  table: ({ children, ...props }) => (
    <div className="table-wrapper">
      <table {...props}>{children}</table>
    </div>
  ),
  // Handle links: external → system browser, anchors → scrollIntoView
  a: ({ href, children, ...props }) => (
    <a
      href={href}
      onClick={(e) => {
        if (!href) return;
        // Internal anchor (footnotes etc.) — scroll within preview
        if (href.startsWith('#')) {
          e.preventDefault();
          const id = href.slice(1);
          const el = document.getElementById(id);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          return;
        }
        // External link — open in system browser via setWindowOpenHandler
        e.preventDefault();
        window.open(href, '_blank');
      }}
      {...props}
    >
      {children}
    </a>
  ),
};

interface MarkdownPreviewProps {
  content: string;
  className?: string;
}

export function MarkdownPreview({ content, className }: MarkdownPreviewProps) {
  return (
    <div
      className={`markdown-preview h-full overflow-y-auto overflow-x-hidden p-6 ${className ?? ''}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeRaw, { passThrough: ['math', 'inlineMath'] }],
          rehypeKatex,
          rehypeHighlight,
        ]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
