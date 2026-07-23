import { useNoteNavGuard } from '@/stores/note-nav-guard';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteNavGuardDialog } from './NoteNavGuardDialog';

beforeEach(() => {
  useNoteNavGuard.setState({ prompt: null });
  vi.restoreAllMocks();
});

describe('NoteNavGuardDialog', () => {
  it('hidden while there is no prompt', () => {
    render(<NoteNavGuardDialog />);
    expect(screen.queryByText('未保存的更改')).toBeNull();
  });

  it('open context: shows 打开笔记 and routes each button to choose', () => {
    useNoteNavGuard.setState({ prompt: { title: '我的笔记', phase: 'prompting', kind: 'open' } });
    const chooseSpy = vi.spyOn(useNoteNavGuard.getState(), 'choose').mockResolvedValue();
    render(<NoteNavGuardDialog />);

    expect(screen.getByText(/我的笔记/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(screen.getByRole('button', { name: '打开笔记' }));
    expect(chooseSpy.mock.calls.map((c) => c[0])).toEqual(['save', 'discard', 'open-current']);
  });

  it('leave context: third button reads 继续编辑', () => {
    useNoteNavGuard.setState({ prompt: { title: 'x', phase: 'prompting', kind: 'leave' } });
    render(<NoteNavGuardDialog />);
    expect(screen.getByRole('button', { name: '继续编辑' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开笔记' })).toBeNull();
  });

  it('saving phase disables the buttons and shows 保存中…', () => {
    useNoteNavGuard.setState({ prompt: { title: 'x', phase: 'saving', kind: 'open' } });
    render(<NoteNavGuardDialog />);
    expect(screen.getByRole('button', { name: '保存中…' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '放弃' })).toHaveProperty('disabled', true);
  });

  it('save-failed phase surfaces 重试 + an error hint', () => {
    useNoteNavGuard.setState({ prompt: { title: 'x', phase: 'save-failed', kind: 'open' } });
    render(<NoteNavGuardDialog />);
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.getByText(/保存失败/)).toBeTruthy();
  });
});
