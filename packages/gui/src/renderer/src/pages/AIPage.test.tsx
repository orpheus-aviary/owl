/**
 * Step 6 (mobile AI, §4.4) — the mobile chat shell: an in-page header (list
 * toggle + 新建对话) over a full-screen chat pane, with the conversation list in
 * a left Sheet. Heavy leaves (MessageList / ChatInput / ChatSidebar) are stubbed;
 * this locks the mobile-only wiring, not the chat internals.
 */

import { useAiStore } from '@/stores/ai-store';
import type { ConversationMeta } from '@/stores/ai-store';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIPage } from './AIPage';

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => true }));
vi.mock('@/hooks/useOwlLayout', () => ({
  useOwlLayout: () => ({ defaultLayout: undefined, onLayoutChanged: () => {} }),
}));
vi.mock('@/platform', () => ({
  getPlatform: () => ({ remoteClient: true, daemonBaseUrl: () => '' }),
}));
vi.mock('@/components/ai/MessageList', () => ({
  MessageList: () => <div data-testid="message-list" />,
}));
vi.mock('@/components/ai/ChatInput', () => ({ ChatInput: () => <div data-testid="chat-input" /> }));
vi.mock('@/components/ai/ChatSidebar', () => ({
  ChatSidebar: () => <div data-testid="chat-sidebar" />,
}));

function meta(id: string, title: string): ConversationMeta {
  return { id, title, createdAt: 0, updatedAt: 0, messageCount: 0 };
}

beforeEach(() => {
  useAiStore.setState({
    conversations: [meta('c1', 'Conv 1')],
    conversationsLoaded: true,
    activeConversationId: 'c1',
    messagesByConversation: { c1: [] },
    streamingByConversation: {},
  });
});

describe('AIPage — mobile shell', () => {
  it('shows the active conversation title and the chat pane', () => {
    render(<AIPage />);
    expect(screen.getByText('Conv 1')).toBeTruthy();
    expect(screen.getByTestId('message-list')).toBeTruthy();
    expect(screen.getByTestId('chat-input')).toBeTruthy();
  });

  it('opens the conversation list Sheet from the header toggle', () => {
    render(<AIPage />);
    // Sheet closed initially — the sidebar isn't mounted.
    expect(screen.queryByTestId('chat-sidebar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '对话列表' }));
    expect(screen.getByTestId('chat-sidebar')).toBeTruthy();
  });

  it('creates a conversation from the header 新建对话 button', () => {
    const spy = vi.spyOn(useAiStore.getState(), 'newConversation');
    render(<AIPage />);
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }));
    expect(spy).toHaveBeenCalled();
  });
});
