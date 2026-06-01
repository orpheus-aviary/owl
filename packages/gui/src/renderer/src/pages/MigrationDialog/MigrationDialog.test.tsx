import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationDialog } from './index';

type ProgressListener = (phase: 'backup' | 'copy' | 'fts-rebuild' | 'swap') => void;

type DaemonFailedListener = () => void;

interface MigrationStub {
  start: ReturnType<typeof vi.fn>;
  onProgress: ReturnType<typeof vi.fn>;
  onDaemonFailed: ReturnType<typeof vi.fn>;
  done: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  _emitProgress: ProgressListener;
  _emitDaemonFailed: DaemonFailedListener;
}

function installMigrationStub(): MigrationStub {
  const listeners = {
    progress: null as ProgressListener | null,
    daemonFailed: null as DaemonFailedListener | null,
  };

  const stub: MigrationStub = {
    start: vi.fn(),
    onProgress: vi.fn((cb: ProgressListener) => {
      listeners.progress = cb;
      return () => {
        listeners.progress = null;
      };
    }),
    onDaemonFailed: vi.fn((cb: DaemonFailedListener) => {
      listeners.daemonFailed = cb;
      return () => {
        listeners.daemonFailed = null;
      };
    }),
    done: vi.fn(),
    quit: vi.fn(),
    _emitProgress: (phase) => listeners.progress?.(phase),
    _emitDaemonFailed: () => listeners.daemonFailed?.(),
  };

  window.owlAPI = {
    daemonUrl: 'http://127.0.0.1:47010',
    startupMode: { mode: 'normal' },
    migration: stub as unknown as typeof window.owlAPI.migration,
    cli: {
      detect: vi.fn(() => Promise.resolve({ installed: false })),
    },
    shortcut: {
      setGlobal: vi.fn(() => Promise.resolve()),
    },
    quit: {
      onCheckUnsaved: vi.fn(() => () => {}),
      respond: vi.fn(),
    },
    sync: {
      login: vi.fn(() => Promise.resolve({ ok: true, data: undefined } as const)),
      logout: vi.fn(() => Promise.resolve({ ok: true, data: undefined } as const)),
      status: vi.fn(() =>
        Promise.resolve({
          ok: true,
          data: { session: null, snapshot: null },
        } as const),
      ),
      devices: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          data: { devices: [] },
        }),
      ),
      revokeDevice: vi.fn(() => Promise.resolve({ ok: true as const, data: { revoked: true } })),
      run: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          data: {
            pulledTotal: 0,
            appliedTotal: 0,
            skippedTotal: 0,
            pushedTotal: 0,
            duplicatesTotal: 0,
            serverSeqHigh: 0,
            cursorBefore: 0,
            cursorAfter: 0,
            conflictsRecorded: 0,
          },
        }),
      ),
      profiles: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          data: {
            active: 'local',
            profiles: [
              {
                id: 'local',
                email: null,
                server_url: null,
                is_active: true,
                can_quick_switch: false,
                db_missing: false,
              },
            ],
          },
        }),
      ),
      switchProfile: vi.fn(() => Promise.resolve({ ok: true, data: undefined } as const)),
      deleteProfile: vi.fn(() =>
        Promise.resolve({ ok: true as const, data: { wasActive: false } }),
      ),
      onProfileSwitched: vi.fn(() => () => {}),
      onClaimPrompt: vi.fn(() => () => {}),
      respondClaim: vi.fn(),
    },
  };

  return stub;
}

describe('MigrationDialog — 4-screen state machine', () => {
  let mig: MigrationStub;

  beforeEach(() => {
    mig = installMigrationStub();
  });

  // M1: migrate-required → ConfirmScreen with dbPath visible
  it('M1: renders ConfirmScreen when mode=migrate-required', () => {
    render(<MigrationDialog startupMode={{ mode: 'migrate-required', dbPath: '/tmp/a.db' }} />);
    expect(screen.getByText('数据库需要迁移')).toBeTruthy();
    expect(screen.getByText('/tmp/a.db')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始迁移' })).toBeTruthy();
  });

  // M2: click 开始迁移 → invokes start, switches to running
  it('M2: click 开始迁移 calls migration.start and shows running screen', async () => {
    // Keep start pending so we can observe the running screen.
    mig.start.mockImplementation(() => new Promise(() => {}));

    render(<MigrationDialog startupMode={{ mode: 'migrate-required', dbPath: '/tmp/a.db' }} />);

    await userEvent.click(screen.getByRole('button', { name: '开始迁移' }));
    expect(mig.start).toHaveBeenCalledTimes(1);
    expect(screen.getByText('正在迁移数据库…')).toBeTruthy();
    // All 4 labels present
    expect(screen.getByText('备份原库')).toBeTruthy();
    expect(screen.getByText('复制数据')).toBeTruthy();
    expect(screen.getByText('重建全文索引')).toBeTruthy();
    expect(screen.getByText('原子替换')).toBeTruthy();
  });

  // M3: progress events advance the 4-step indicator
  it('M3: progress events flow through 4 phases in order', async () => {
    mig.start.mockImplementation(() => new Promise(() => {}));

    render(<MigrationDialog startupMode={{ mode: 'migrate-required', dbPath: '/tmp/a.db' }} />);
    await userEvent.click(screen.getByRole('button', { name: '开始迁移' }));

    const phases: Array<'backup' | 'copy' | 'fts-rebuild' | 'swap'> = [
      'backup',
      'copy',
      'fts-rebuild',
      'swap',
    ];
    for (const phase of phases) {
      act(() => {
        mig._emitProgress(phase);
      });
      // Active step carries aria-label='进行中'; there should be exactly one.
      const activeIcons = screen.getAllByLabelText('进行中');
      expect(activeIcons.length).toBe(1);
    }
  });

  // M4: resolve ok → success screen; click 完成 → migration.done
  it('M4: ok result shows success + 完成 triggers done()', async () => {
    mig.start.mockResolvedValue({
      ok: true,
      backupPath: '/tmp/a.db.v0.2-backup-1',
      notesCount: 52,
      elapsedMs: 420,
    });

    render(<MigrationDialog startupMode={{ mode: 'migrate-required', dbPath: '/tmp/a.db' }} />);
    await userEvent.click(screen.getByRole('button', { name: '开始迁移' }));

    await waitFor(() => {
      expect(screen.getByText('迁移成功')).toBeTruthy();
    });
    expect(screen.getByText(/52 条笔记/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(mig.done).toHaveBeenCalledTimes(1);
  });

  // M5: error result + retry calls start a second time
  it('M5: error daemon_alive → error screen + retry re-invokes start', async () => {
    mig.start.mockResolvedValue({
      ok: false,
      reason: 'daemon_alive',
      message: 'daemon running',
    });

    render(<MigrationDialog startupMode={{ mode: 'migrate-required', dbPath: '/tmp/a.db' }} />);
    await userEvent.click(screen.getByRole('button', { name: '开始迁移' }));

    await waitFor(() => {
      expect(screen.getByText('检测到 daemon 正在运行')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();

    // Second start — make it pending so the render doesn't bounce back to error
    mig.start.mockImplementation(() => new Promise(() => {}));
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(mig.start).toHaveBeenCalledTimes(2);
  });

  // M6: incompatible mode → error screen, no 重试 button
  it('M6: incompatible mode goes straight to error (no retry)', () => {
    render(
      <MigrationDialog
        startupMode={{
          mode: 'incompatible',
          dbPath: '/tmp/a.db',
          dbVersion: 99,
          maxSupported: 1,
        }}
      />,
    );
    expect(screen.getByText('数据库版本过新')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.getByRole('button', { name: '退出' })).toBeTruthy();
  });

  // M7: daemon-failed event after success → banner + retry done()
  it('M7: daemon-failed after success shows banner + 再试一次 triggers done()', async () => {
    mig.start.mockResolvedValue({
      ok: true,
      backupPath: '/tmp/a.db.v0.2-backup-1',
      notesCount: 2,
      elapsedMs: 100,
    });

    render(<MigrationDialog startupMode={{ mode: 'migrate-required', dbPath: '/tmp/a.db' }} />);
    await userEvent.click(screen.getByRole('button', { name: '开始迁移' }));

    await waitFor(() => {
      expect(screen.getByText('迁移成功')).toBeTruthy();
    });

    // Fire daemon-failed
    act(() => {
      mig._emitDaemonFailed();
    });

    expect(screen.getByText('启动 daemon 失败。请查看 logs/daemon.log 后重试。')).toBeTruthy();
    const retryBtn = screen.getByRole('button', { name: '再试一次' });
    fireEvent.click(retryBtn);
    expect(mig.done).toHaveBeenCalledTimes(1);
  });
});
