import { getPlatform } from '@/platform';
import type { MigratePhase, StartupMode } from '@/types/owl-api';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmScreen } from './ConfirmScreen';
import { ErrorScreen } from './ErrorScreen';
import { RunningScreen } from './RunningScreen';
import { SuccessScreen } from './SuccessScreen';

interface SuccessResult {
  backupPath: string;
  notesCount: number;
  elapsedMs: number;
}

type Screen =
  | { kind: 'confirm' }
  | { kind: 'running'; currentPhase: MigratePhase | null }
  | { kind: 'success'; result: SuccessResult; daemonFailed: boolean }
  | { kind: 'error'; reason: string; message: string };

function initialScreen(startupMode: StartupMode): Screen {
  if (startupMode.mode === 'incompatible') {
    return {
      kind: 'error',
      reason: 'incompatible',
      message: `数据库 v${startupMode.dbVersion} 来自更新版本应用（本版本支持到 v${startupMode.maxSupported}），请升级 Owl。`,
    };
  }
  return { kind: 'confirm' };
}

interface Props {
  startupMode: Exclude<StartupMode, { mode: 'normal' }>;
}

/**
 * 4-screen state machine: confirm → running → success | error.
 *
 * - `migration:start` resolves with ok | {reason,message} — map to success
 *   or error accordingly.
 * - `migration:progress` ticks currentPhase through the 4 phases in order.
 *   When the promise resolves with ok, we flip currentPhase to 'swap' so
 *   the running screen briefly shows the final step as active/done before
 *   switching to success.
 * - `migration:daemon-failed` only fires after the user clicks "done" and
 *   main-process spawns the daemon unsuccessfully. It can arrive after the
 *   screen is already in success state; we fold the flag in without
 *   touching kind so the user still sees the result counts.
 */
export function MigrationDialog({ startupMode }: Props) {
  const [screen, setScreen] = useState<Screen>(() => initialScreen(startupMode));

  // Electron-only capability. This dialog is only reached when startupMode is
  // not 'normal', which the web host never produces, so `migration` is always
  // present here — the optional chaining is purely for the platform type.
  const migration = getPlatform().migration;

  const dbPath = startupMode.mode === 'migrate-required' ? startupMode.dbPath : '';

  // Listen for daemon-failed throughout — subscription cost is minimal, and
  // setting it up on success-screen mount would miss an early-arriving event.
  useEffect(() => {
    const unsub = migration?.onDaemonFailed(() => {
      setScreen((prev) => (prev.kind === 'success' ? { ...prev, daemonFailed: true } : prev));
    });
    return unsub;
  }, [migration]);

  const runMigration = useCallback(async () => {
    setScreen({ kind: 'running', currentPhase: null });

    const unsubProgress = migration?.onProgress((phase) => {
      setScreen((prev) => (prev.kind === 'running' ? { ...prev, currentPhase: phase } : prev));
    });

    try {
      const result = await migration?.start();
      if (!result) return;
      if (result.ok) {
        setScreen({
          kind: 'success',
          result: {
            backupPath: result.backupPath,
            notesCount: result.notesCount,
            elapsedMs: result.elapsedMs,
          },
          daemonFailed: false,
        });
      } else {
        setScreen({ kind: 'error', reason: result.reason, message: result.message });
      }
    } finally {
      unsubProgress?.();
    }
  }, [migration]);

  const onQuit = () => migration?.quit();
  const onDone = () => migration?.done();

  switch (screen.kind) {
    case 'confirm':
      return <ConfirmScreen dbPath={dbPath} onStart={runMigration} onQuit={onQuit} />;

    case 'running':
      return <RunningScreen currentPhase={screen.currentPhase} />;

    case 'success':
      return (
        <SuccessScreen
          notesCount={screen.result.notesCount}
          elapsedMs={screen.result.elapsedMs}
          backupPath={screen.result.backupPath}
          daemonFailed={screen.daemonFailed}
          onDone={onDone}
          onQuit={onQuit}
        />
      );

    case 'error':
      return (
        <ErrorScreen
          reason={screen.reason}
          message={screen.message}
          onRetry={runMigration}
          onQuit={onQuit}
        />
      );
  }
}
