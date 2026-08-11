#!/usr/bin/env bash
# 0.6.3 V3 — the cloud session watchdog must stay wired to the PROCESS
# lifecycle, not to the sync background handles.
#
# Three things this guard pins, none of which a unit test of the watchdog
# module itself can see:
#
#  1. boot.ts actually starts it and stores the handle on ctx. A watchdog
#     that is written but never started is worse than none — it reads as
#     covered.
#  2. boot.ts's graceful shutdown stops it.
#  3. `stopBackgroundHandles` does NOT touch it. `teardownCloudSession`
#     calls that helper and never restarts the handles, so putting the
#     watchdog in that set would kill the alarm at the exact moment the
#     session became permanently lost — the state it exists to report.

set -euo pipefail

fail=0

if ! rg -q 'ctx\.sessionWatchdog = startSessionWatchdog\(' packages/daemon/src/boot.ts; then
  echo "✗ boot.ts must start the session watchdog and store it on ctx"
  fail=1
fi

if ! rg -q 'ctx\.sessionWatchdog\?\.stop\(\)' packages/daemon/src/boot.ts; then
  echo "✗ boot.ts graceful shutdown must stop the session watchdog"
  fail=1
fi

if rg -q 'sessionWatchdog' packages/daemon/src/sync/bridge-lifecycle.ts; then
  echo "✗ the session watchdog must NOT live in bridge-lifecycle"
  echo "  teardownCloudSession() stops those handles and never restarts them,"
  echo "  which would silence the watchdog exactly when the session is lost."
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "✓ session watchdog wired to the process lifecycle"
