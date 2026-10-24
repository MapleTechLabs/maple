#!/bin/sh
# `start` (the default) runs the self-hosted server and refuses to start without
# its secrets; any other command is passed to `maple` unchanged.
set -eu

MAPLE_UID=10001

if [ "${1:-start}" != "start" ]; then
	exec /opt/maple/maple "$@"
fi
[ "$#" -gt 0 ] && shift

for name in MAPLE_LOCAL_INGEST_KEY MAPLE_LOCAL_ACCESS_TOKEN; do
	eval "value=\${$name:-}"
	if [ -z "$value" ]; then
		echo "error: $name is required (generate one with: openssl rand -hex 32)" >&2
		exit 64
	fi
done

# The store lives on the volume whatever HOME the platform sets; the probe
# below and the chown agree on that.
export HOME=/data

# After an unclean stop (OOM kill, host crash) the store restores its last
# checkpoint. Before the first one exists there is nothing to recover, and
# refusing to start would crash-loop the container, so it starts fresh.
on_dirty_store=wipe
if [ -f "$HOME/.maple/data/backups/state.json" ]; then
	on_dirty_store=restore-checkpoint
fi
set -- /opt/maple/maple start --host 0.0.0.0 --port "${PORT:-4318}" --offline \
	--on-dirty-store "$on_dirty_store" "$@"

if [ "$(id -u)" = 0 ]; then
	# Platform volumes are often mounted root-owned: hand them to the server user, then drop root.
	# -h and -xdev: never follow a link or another mount out of the volume.
	find /data -xdev \( ! -user "$MAPLE_UID" -o ! -group "$MAPLE_UID" \) -exec chown -h "$MAPLE_UID:$MAPLE_UID" {} +
	exec setpriv --reuid="$MAPLE_UID" --regid="$MAPLE_UID" --clear-groups --inh-caps=-all \
		--bounding-set=-all --no-new-privs "$@"
fi
exec "$@"
