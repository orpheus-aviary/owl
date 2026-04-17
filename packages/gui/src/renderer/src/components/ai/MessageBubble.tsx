import { MarkdownPreview } from '@/components/MarkdownPreview';
import type { ChatMessage, DraftReadyCard as DraftReadyData } from '@/stores/ai-store';
import { useAiStore } from '@/stores/ai-store';
import { useEditorStore } from '@/stores/editor-store';
import { AlertCircle } from 'lucide-react';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { DraftReadyCard } from './DraftReadyCard';
import { PreviewReadyCard } from './PreviewReadyCard';
import { ToolCallBlock } from './ToolCallBlock';

interface MessageBubbleProps {
  message: ChatMessage;
  chatId: string;
}

/**
 * Hand an AI draft off to the editor:
 *   - create / create_reminder → seed a brand-new draft tab (`draft_<uuid>`
 *     id; saved via Cmd+S). No server call here.
 *   - update → stage the payload on the already-open tab so Cmd+S flows
 *     through the AI-staged update path (PATCH /notes/:id). If the tab
 *     isn't open yet we open it first via `openNoteById` so the user
 *     has something to interact with.
 *   Then mark the card's `opened` flag and navigate to the editor.
 */
function useOpenDraft(chatId: string, messageId: string) {
  const markDraftOpened = useAiStore((s) => s.markDraftOpened);
  const navigate = useNavigate();
  return useCallback(
    async (draft: DraftReadyData) => {
      const editor = useEditorStore.getState();
      if (draft.action === 'update') {
        const alreadyOpen = editor.tabs.some((t) => t.noteId === draft.note_id);
        if (!alreadyOpen) {
          const { openNoteById } = await import('@/stores/editor-store');
          await openNoteById(draft.note_id);
        }
        editor.stageAiUpdate(draft.note_id, {
          action: 'update',
          content: draft.content,
          tags: draft.tags,
          folder_id: draft.folder_id,
          original_content: draft.original_content,
          original_tags: draft.original_tags,
          original_folder_id: draft.original_folder_id,
        });
        editor.setActiveTab(draft.note_id);
      } else {
        editor.openAiDraft({
          note_id: draft.note_id,
          content: draft.content,
          tags: draft.tags,
          folder_id: draft.folder_id,
          action: draft.action,
        });
      }
      markDraftOpened(chatId, messageId, draft.localId);
      navigate('/');
    },
    [chatId, messageId, markDraftOpened, navigate],
  );
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
export function MessageBubble({ message, chatId }: MessageBubbleProps) {
  if (message.role === 'user') return <UserBubble message={message} />;
  return <AssistantBubble message={message} chatId={chatId} />;
}

function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-lg bg-accent text-accent-foreground px-3 py-2 text-sm whitespace-pre-wrap break-words">
        {message.content}
      </div>
    </div>
  );
}

function AssistantBubble({ message, chatId }: { message: ChatMessage; chatId: string }) {
  const openDraft = useOpenDraft(chatId, message.id);
  if (message.error) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 text-sm">
        <AlertCircle className="size-4 shrink-0 mt-0.5" />
        <span className="whitespace-pre-wrap">{message.error}</span>
      </div>
    );
  }

  // Tool calls + drafts + previews can arrive before the assistant text
  // does — render them whenever they exist instead of gating on content.
  const hasAnything =
    message.content ||
    message.toolCalls.length > 0 ||
    message.drafts.length > 0 ||
    message.previews.length > 0;
  const showThinking = message.isStreaming && !hasAnything;

  // Chronological order: the daemon emits tool_call → tool_result → final
  // `message` text as the LLM finishes the turn. Render tool calls, drafts
  // and previews FIRST, then the assistant's summary text below, so the
  // visual top-to-bottom flow matches the user's mental model of "the AI
  // did X, then explained it".
  return (
    <div className="rounded-lg bg-muted/40 px-1 py-2 space-y-2">
      {showThinking && <ThinkingPlaceholder />}
      {message.toolCalls.length > 0 && (
        <div className="px-1 space-y-1">
          {message.toolCalls.map((tc) => (
            <ToolCallBlock key={tc.id} call={tc} />
          ))}
        </div>
      )}
      {message.drafts.length > 0 && (
        <div className="px-1 space-y-2">
          {message.drafts.map((d) => (
            <DraftReadyCard
              key={d.localId}
              draft={d}
              onOpen={(draft) => {
                void openDraft(draft);
              }}
            />
          ))}
        </div>
      )}
      {message.previews.length > 0 && (
        <div className="px-1 space-y-2">
          {message.previews.map((p) => (
            <PreviewReadyCard key={p.localId} preview={p} />
          ))}
        </div>
      )}
      {message.content && (
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
      {message.aborted && !message.isStreaming && (
        <div className="px-3 pb-1 text-xs text-muted-foreground/70 italic">⏹ 已停止生成</div>
      )}
    </div>
  );
}

function ThinkingPlaceholder() {
  return (
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
  );
}
