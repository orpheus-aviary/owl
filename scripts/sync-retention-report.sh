#!/usr/bin/env bash
# 0.6.2 W2 outbox 裁剪体检 —— 对任意 owl.db 只读取数。
#
# 为什么固化成脚本：裁剪的效果只能靠长期观察，每次复盘都要拼同一套 SQL。
# 2026-08-11 那次复盘就是临时拼出来的，结果只留在对话里 —— 下次要用得重写。
#
# ⚠️ 判断「裁剪装没装」要看 db，不能看日志：水位由 installSkybridgeSession
# 直接写入且不打日志，无可裁行时 deleted:0 也不打日志。所以「日志里没有
# sync-retention」是健康态，不是异常。
#
# 用法:
#   bash scripts/sync-retention-report.sh ~/orpheus-aviary-nest/owl/profiles/<id>/owl.db
#   bash scripts/sync-retention-report.sh /www/owl-nest/owl/profiles/*/owl.db   # 云端
set -euo pipefail
DB="${1:?usage: sync-retention-report.sh <path/to/owl.db>}"
command -v sqlite3 >/dev/null || { echo "需要 sqlite3：sudo apt-get install -y sqlite3"; exit 1; }

echo "== db: $DB  ($(du -h "$DB" | cut -f1)) =="

# 时间全部在 SQLite 内算，避免 shell 的整数/时区差异。
sqlite3 -readonly -box "$DB" "
WITH p AS (SELECT
    coalesce((SELECT CAST(value AS INTEGER) FROM local_metadata
              WHERE key='sync_retention_safe_after_local_seq'), -1) AS wm,
    coalesce((SELECT pulled_seq FROM sync_cursor LIMIT 1), -1) AS ps,
    strftime('%s','now')*1000 - 604800000 AS cut)   -- RETENTION_MS = 7 天
SELECT 'user_version (需=11)' AS 项, (SELECT * FROM pragma_user_version) AS 值 FROM p
UNION ALL SELECT 'watermark safe_after',
  CASE WHEN wm<0 THEN '<未写入 → 从未装过 session>' ELSE CAST(wm AS TEXT) END FROM p
UNION ALL SELECT 'sync_cursor 行数 (闸1 需=1)', (SELECT count(*) FROM sync_cursor) FROM p
UNION ALL SELECT 'endpoint / pulled_seq / pushed_seq',
  (SELECT endpoint||'  '||pulled_seq||'/'||pushed_seq FROM sync_cursor LIMIT 1) FROM p
UNION ALL SELECT 'sync_changes 总行数', (SELECT count(*) FROM sync_changes) FROM p
UNION ALL SELECT '  其中 pending', (SELECT count(*) FROM sync_changes WHERE synced_at IS NULL) FROM p
UNION ALL SELECT 'max local_seq (历史总写入)', (SELECT coalesce(max(local_seq),0) FROM sync_changes) FROM p
UNION ALL SELECT '推算已裁行数', (SELECT coalesce(max(local_seq),0)-count(*) FROM sync_changes) FROM p
UNION ALL SELECT '水位以下冻结行 (永不裁)', (SELECT count(*) FROM sync_changes WHERE local_seq<=wm) FROM p
-- 少量（个位数）属正常：裁剪每小时最多跑一次，这些是上次裁剪之后才跨过
-- 7 天窗的行。持续几十上百行不降才说明某道闸被卡住了。
UNION ALL SELECT '★该裁未裁 (个位数正常, 见注释)', (SELECT count(*) FROM sync_changes
    WHERE local_seq>wm AND synced_at IS NOT NULL AND synced_at<cut
      AND server_seq IS NOT NULL AND server_seq<=ps) FROM p
UNION ALL SELECT '  超龄但游标没跟上 (闸3挡住)', (SELECT count(*) FROM sync_changes
    WHERE synced_at IS NOT NULL AND synced_at<cut
      AND (server_seq IS NULL OR server_seq>ps)) FROM p
UNION ALL SELECT '最老存活 acked 行',
  (SELECT datetime(min(synced_at)/1000,'unixepoch','localtime') FROM sync_changes
   WHERE local_seq>wm AND synced_at IS NOT NULL) FROM p
UNION ALL SELECT '7 天窗 cutoff', (SELECT datetime(cut/1000,'unixepoch','localtime')) FROM p;

SELECT date(synced_at/1000,'unixepoch','localtime') AS acked_day,
       count(*) AS n, min(local_seq) AS lo, max(local_seq) AS hi
  FROM sync_changes GROUP BY 1 ORDER BY 1;
"

echo "== 日志里的裁剪事件（只有 deleted>0 才打；pruned:false 每进程每 reason 只 warn 一次）=="
D1="$(dirname "$DB")"
for LOGDIR in "$D1/logs" "$(dirname "$D1")/logs" "$(dirname "$(dirname "$D1")")/logs"; do
  if compgen -G "$LOGDIR/daemon.log*" >/dev/null; then
    echo "(from $LOGDIR)"
    grep -h "sync-retention" "$LOGDIR"/daemon.log* 2>/dev/null | tail -10
    grep -ho '"deleted":[0-9]*' "$LOGDIR"/daemon.log* 2>/dev/null |
      grep -o '[0-9]*' | awk '{s+=$1; n++} END {print "合计: events="n+0, "deleted="s+0}'
    exit 0
  fi
done
echo "（未找到 daemon.log*，手工指定日志目录后 grep sync-retention）"
