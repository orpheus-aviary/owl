/**
 * P5-d (multi-account add) — LoginForm.tsx props contract. End-to-end wiring
 * (status → login → identity) lives in SyncSection.test; this locks the bits
 * unique to the extracted form: server prefill, in-form error, the optional
 * cancel, and the submit payload.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SERVER_URL, LoginForm } from './LoginForm';

function fill(email: string, password: string) {
  const emailInput = screen
    .getAllByRole('textbox')
    .find((el) => el.getAttribute('type') === 'email');
  fireEvent.change(emailInput as HTMLElement, { target: { value: email } });
  fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, {
    target: { value: password },
  });
}

describe('LoginForm', () => {
  it('seeds the server input from initialServerUrl (not the default)', () => {
    render(
      <LoginForm
        initialServerUrl="http://srv"
        submitting={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue('http://srv')).toBeTruthy();
    expect(screen.queryByDisplayValue(DEFAULT_SERVER_URL)).toBeNull();
  });

  it('submits trimmed values', () => {
    const onSubmit = vi.fn();
    render(
      <LoginForm
        initialServerUrl="http://srv"
        submitting={false}
        error={null}
        onSubmit={onSubmit}
      />,
    );
    fill('  b@test  ', 'pw2');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(onSubmit).toHaveBeenCalledWith({
      serverUrl: 'http://srv',
      email: 'b@test',
      password: 'pw2',
      remember: false,
    });
  });

  it('shows 记住我 only with showRemember, and submits remember:true when checked', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <LoginForm
        initialServerUrl="http://srv"
        submitting={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    );
    // Off by default (desktop add-account view).
    expect(screen.queryByRole('checkbox')).toBeNull();

    rerender(
      <LoginForm
        initialServerUrl="http://srv"
        submitting={false}
        error={null}
        onSubmit={onSubmit}
        showRemember
      />,
    );
    fill('b@test', 'pw');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(onSubmit).toHaveBeenCalledWith({
      serverUrl: 'http://srv',
      email: 'b@test',
      password: 'pw',
      remember: true,
    });
  });

  it('disables submit until email + password are present', () => {
    render(
      <LoginForm
        initialServerUrl="http://srv"
        submitting={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '登录' }).hasAttribute('disabled')).toBe(true);
    fill('b@test', 'pw');
    expect(screen.getByRole('button', { name: '登录' }).hasAttribute('disabled')).toBe(false);
  });

  it('renders the error inside the form', () => {
    render(
      <LoginForm
        initialServerUrl="http://srv"
        submitting={false}
        error="邮箱或密码不正确"
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText('邮箱或密码不正确')).toBeTruthy();
  });

  it('shows 取消 only when onCancel is given, and calls it', () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <LoginForm
        initialServerUrl="http://srv"
        submitting={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();

    rerender(
      <LoginForm
        initialServerUrl="http://srv"
        submitting={false}
        error={null}
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
