import { MarkdownPreview } from '@/components/MarkdownPreview';
import type { ChatMessage } from '@/stores/ai-store';
import { AlertCircle } from 'lucide-react';

interface MessageBubbleProps {
  message: ChatMessage;
}

/**
 * Single chat message. User messages render as plain text in a tighter
 * bubble; assistant messages get full markdown rendering and a streaming
 * cursor while content is still arriving.
 *
 * Tool calls / drafts / previews are NOT rendered here in step 4 — those
 * are layered on in step 5 by mounting child components (`ToolCallBlock`,
 * `DraftReadyCard`) inside the assistant bubble. The data is already on
 * `message.toolCalls / .drafts / .previews`.
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === 'user') return <UserBubble message={message} />;
  return <AssistantBubble message={message} />;
}

function UserBubble({ message }: MessageBubbleProps) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-lg bg-accent text-accent-foreground px-3 py-2 text-sm whitespace-pre-wrap break-words">
        {message.content}
      </div>
    </div>
  );
}

function AssistantBubble({ message }: MessageBubbleProps) {
  if (message.error) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 text-sm">
        <AlertCircle className="size-4 shrink-0 mt-0.5" />
        <span className="whitespace-pre-wrap">{message.error}</span>
      </div>
    );
  }

  // While streaming with no body yet, show a "thinking" placeholder so
  // the user knows their request landed (otherwise the page looks frozen
  // until the first text_delta from the LLM).
  const showThinking = message.isStreaming && !message.content;

  return (
    <div className="rounded-lg bg-muted/40 px-1 py-2">
      {showThinking ? (
        <div className="flex items-center gap-2 px-2 text-sm text-muted-foreground">
          <span className="inline-flex gap-1">
            <span className="size-1.5 rounded-full bg-current animate-pulse" />
            <span
              className="size-1.5 rounded-full bg-current animate-pulse"
              style={{ animationDelay: '0.15s' }}
            />
            <span
              className="size-1.5 rounded-full bg-current animate-pulse"
              style={{ animationDelay: '0.3s' }}
            />
          </span>
          思考中…
        </div>
      ) : (
        <div className="relative">
          <MarkdownPreview content={message.content} className="!p-2 !overflow-visible" />
          {message.isStreaming && (
            <span
              aria-hidden="true"
              className="inline-block size-2 ml-0.5 -mb-0.5 bg-foreground/60 animate-pulse"
            />
          )}
        </div>
      )}
    </div>
  );
}
