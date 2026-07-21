// Phase B (B1) — web host login gate. A cloud daemon 401s without a bearer, so
// the web app blocks on login before rendering MainApp. Electron never mounts
// this (platform.requiresAuth === false). The session lives in memory only
// (web-session.ts, design ⭐2): a refresh drops it and returns here.

import { useState, useSyncExternalStore } from 'react';
import { MainApp } from '../MainApp';
import { getPlatform } from '../platform';
import { getWebSession, subscribeWebSession } from '../platform/web-session';
import { LoginForm, type LoginFormValues } from './settings/LoginForm';

function useWebSession() {
  return useSyncExternalStore(subscribeWebSession, getWebSession);
}

export function WebAuthGate() {
  const session = useWebSession();
  if (!session) return <WebLoginScreen />;
  return <MainApp />;
}

function WebLoginScreen() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (values: LoginFormValues) => {
    setSubmitting(true);
    setError(null);
    const reply = await getPlatform().sync.login(values);
    // On success the in-memory session updates → WebAuthGate re-renders into
    // MainApp and this screen unmounts; only the failure path lands back here.
    if (!reply.ok) {
      setError(reply.message);
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-4">
        <div className="text-center space-y-1">
          <h1 className="text-xl font-semibold text-foreground">猫头鹰笔记</h1>
          <p className="text-sm text-muted-foreground">登录到你的云端账号</p>
        </div>
        <LoginForm
          initialServerUrl={window.location.origin}
          hideServerUrl
          showRemember
          submitting={submitting}
          error={error}
          onSubmit={onSubmit}
        />
      </div>
    </div>
  );
}
