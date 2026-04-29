// Reason → UI copy mapping for MigrationDialog's error screen.
//
// Keep reasons stable strings — they cross the IPC boundary from main's
// mapMigrationError. Any reason not listed here falls through to 'unknown'.

export interface ErrorCopy {
  title: string;
  body: string;
  showRetry: boolean;
}

/**
 * Build the displayed copy for an error. `message` is the payload from main —
 * used as a fallback body for 'unknown' / 'schema_mismatch' / 'incompatible'
 * where the dynamic detail lives there.
 */
export function errorCopyFor(reason: string, message: string): ErrorCopy {
  switch (reason) {
    case 'daemon_alive':
      return {
        title: '检测到 daemon 正在运行',
        body: '另一个 Owl 进程在访问数据库。请完全关闭 Owl（菜单栏或 `kill <pid>`）后重试。',
        showRetry: true,
      };
    case 'lock_file':
      return {
        title: '发现残留锁文件',
        body: '`.migrate.lock` 存在。上次迁移可能异常退出，请手动删除后重试。',
        showRetry: true,
      };
    case 'exclusive_lock_busy':
      return {
        title: '数据库被占用',
        body: '无法获取独占锁。其它进程可能持有连接，请关闭后重试。',
        showRetry: true,
      };
    case 'checkpoint_busy':
      return {
        title: 'WAL checkpoint 失败',
        body: '无法获取独占锁。其它进程可能持有连接，请关闭后重试。',
        showRetry: true,
      };
    case 'begin_busy':
      return {
        title: '事务启动失败',
        body: '罕见错误，请关闭所有访问此库的进程后重试。',
        showRetry: true,
      };
    case 'source_db_corruption':
      return {
        title: '源库数据损坏',
        body: message,
        showRetry: false,
      };
    case 'schema_mismatch':
      return {
        title: '源库结构不匹配',
        body: message,
        showRetry: false,
      };
    case 'incompatible':
      return {
        title: '数据库版本过新',
        body: message,
        showRetry: false,
      };
    default:
      return {
        title: '迁移失败',
        body: message || '未知错误。',
        showRetry: true,
      };
  }
}
