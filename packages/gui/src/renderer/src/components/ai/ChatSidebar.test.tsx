/**
 * Step 6 (mobile AI) — the `onAfterSelect` hook the mobile shell uses to close
 * the conversation Sheet. Selecting a row or creating a conversation must both
 * fire it (and still update the store); desktop passes no callback.
 */

import { useAiStore } from '@/stores/ai-store';
import type { ConversationMeta } from '@/stores/ai-store';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSidebar } from './ChatSidebar';

// ChatSidebar → ai-store → api/transport transitively reads the platform.
vi.mock('@/platform', () => ({
  getPlatform: () => ({ remoteClient: false, daemonBaseUrl: () => '' }),
}));

function meta(id: string, title: string): ConversationMeta {
  return { id, title, createdAt: 0, updatedAt: 0, messageCount: 0 };
}

beforeEach(() => {
  useAiStore.setState({
    conversations: [meta('c1', 'Conv 1'), meta('c2', 'Conv 2')],
    activeConversationId: null,
    streamingByConversation: {},
    messagesByConversation: {},
  });
});

describe('ChatSidebar onAfterSelect', () => {
  it('fires after selecting a conversation and sets it active', () => {
    const onAfterSelect = vi.fn();
    render(<ChatSidebar onAfterSelect={onAfterSelect} />);
    fireEvent.click(screen.getByText('Conv 2'));
    expect(useAiStore.getState().activeConversationId).toBe('c2');
    expect(onAfterSelect).toHaveBeenCalledTimes(1);
  });

  it('fires after 新建对话', () => {
    const onAfterSelect = vi.fn();
    render(<ChatSidebar onAfterSelect={onAfterSelect} />);
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }));
    expect(onAfterSelect).toHaveBeenCalledTimes(1);
    // A fresh ephemeral conversation is now active.
    expect(useAiStore.getState().activeConversationId).not.toBeNull();
  });

  it('is a no-op safety when omitted (desktop)', () => {
    render(<ChatSidebar />);
    // No throw when selecting without a callback.
    fireEvent.click(screen.getByText('Conv 1'));
    expect(useAiStore.getState().activeConversationId).toBe('c1');
  });
});
