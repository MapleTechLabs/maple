#!/bin/sh
# Starts as root only to hand the WAL directory (a host bind mount that may hold files an older,
# root-run task wrote) to the gateway's user, then runs the gateway as that user. `exec` keeps the
# gateway PID 1, so ECS's SIGTERM still reaches it for a graceful drain.
set -eu

uid=10001
dir="${INGEST_QUEUE_DIR:-/var/lib/maple-ingest/wal}"

mkdir -p "$dir"
if [ "$(stat -c %u "$dir")" != "$uid" ]; then
	chown -R "$uid:$uid" "$dir"
fi

exec setpriv --reuid="$uid" --regid="$uid" --clear-groups -- /usr/local/bin/maple-ingest "$@"
