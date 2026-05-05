import { MarkdownPreview } from '@/components/MarkdownPreview';
import type { ChatMessage, DraftReadyCard as DraftReadyData } from '@/stores/ai-store';
import { useAiStore } from '@/stores/ai-store';
import { useEditorStore } from '@/stores/editor-store';
import { AlertCircle, Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useState } from 'react';
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
      {message.thinking && (
        <ThinkingBlock content={message.thinking} streaming={message.isStreaming} />
      )}
      {message.toolCalls.length > 0 && (
        <div className="px-1 space-y-1">
          {message.toolCalls.map((tc) => (
            <ToolCallBlock key={tc.id} call={tc} />
          ))}
        </div>
      )}
      {message.drafts.length > 0 && (
        <DraftSection
          drafts={message.drafts}
          chatId={chatId}
          messageId={message.id}
          onOpen={openDraft}
        />
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
          <MarkdownPreview
            content={message.content}
            className="!p-2 !overflow-visible"
            linkifyNoteIds
          />
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

/**
 * Collapsible reasoning / chain-of-thought block. Always default collapsed
 * (even while streaming) — users opt in if they want to peek at the model's
 * private reasoning.
 */
function ThinkingBlock({ content, streaming }: { content: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Brain className="size-3" />
        <span>思考过程</span>
        {streaming && <span className="text-[10px] opacity-60">(进行中…)</span>}
      </button>
      {open && (
        <div className="mt-1 ml-4 pl-2 border-l-2 border-muted-foreground/20 text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
          {content}
        </div>
      )}
    </div>
  );
}

/**
 * Draft cards section + a "同意全部" button when 2+ unprocessed drafts exist.
 * Approve goes through ai-store.approveDraft → daemon REST API directly,
 * NOT through editor staging — that's the Tier-1 path so the user doesn't
 * have to context-switch into the editor for routine accept-the-AI flows.
 */
function DraftSection({
  drafts,
  chatId,
  messageId,
  onOpen,
}: {
  drafts: DraftReadyData[];
  chatId: string;
  messageId: string;
  onOpen: (draft: DraftReadyData) => Promise<void>;
}) {
  const approveDraft = useAiStore((s) => s.approveDraft);
  const approveAllDrafts = useAiStore((s) => s.approveAllDrafts);
  const unprocessed = drafts.filter((d) => !d.opened && !d.approved);
  const anyApproving = drafts.some((d) => d.approving);
  const showBatch = unprocessed.length >= 2;
  return (
    <div className="px-1 space-y-2">
      {showBatch && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => {
              void approveAllDrafts(chatId, messageId);
            }}
            disabled={anyApproving}
            className="text-xs px-2.5 py-1 rounded border border-border bg-muted/40 hover:bg-muted disabled:opacity-50"
          >
            同意全部 ({unprocessed.length})
          </button>
        </div>
      )}
      {drafts.map((d) => (
        <DraftReadyCard
          key={d.localId}
          draft={d}
          onOpen={(draft) => {
            void onOpen(draft);
          }}
          onApprove={(draft) => {
            void approveDraft(chatId, messageId, draft.localId);
          }}
        />
      ))}
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
