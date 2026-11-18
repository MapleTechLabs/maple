#!/bin/sh
# Starts as root only to hand the WAL directory (a host bind mount that may hold files an older,
# root-run task wrote) to the gateway's user, then runs the gateway as that user. `exec` keeps the
# gateway PID 1, so ECS's SIGTERM still reaches it for a graceful drain.
set -eu

uid=10001
dir="${INGEST_QUEUE_DIR:-/var/lib/maple-ingest/wal}"

mkdir -p "$dir"
# Any entry an older or rolled-back root task wrote, not just the directory itself.
if [ -n "$(find "$dir" ! -uid "$uid" -print -quit)" ]; then
	chown -R "$uid:$uid" "$dir"
fi

# No capability can come back: an empty bounding and inheritable set, and no_new_privs so a
# setuid binary cannot raise privileges either.
exec setpriv --reuid="$uid" --regid="$uid" --clear-groups --inh-caps=-all --bounding-set=-all \
	--no-new-privs -- /usr/local/bin/maple-ingest "$@"
