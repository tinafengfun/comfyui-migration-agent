import type { ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Shared GFM markdown renderer for all human-facing decision text (step
 * summaries, human-gate questions/decision context, chat messages). Renders
 * tables, lists, code and clickable links. react-markdown escapes raw HTML by
 * default (no rehype-raw), so this is safe against injected markup. Links open
 * in a new tab so opening the ComfyUI verification URL never navigates away
 * from the task view.
 */
export function Markdown({ source, className }: { source?: string | null; className?: string }): ReactElement | null {
  if (!source) return null;
  return (
    <div className={`markdown-body${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
