#!/bin/sh
# `start` (the default) runs the self-hosted server and refuses to start without
# its secrets; any other command is passed to `maple` unchanged.
set -eu

MAPLE_UID=10001

if [ "${1:-start}" != "start" ]; then
	exec /opt/maple/maple "$@"
fi
[ "$#" -gt 0 ] && shift

# maple trims a secret the way JavaScript does and treats a blank one as unset, which would
# serve without auth. So blank here means the same: ASCII whitespace plus, as UTF-8 bytes,
# U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF.
is_blank() {
	[ -z "$(printf '%s' "$1" | LC_ALL=C sed \
		-e 's/[[:space:]]//g' \
		-e "$(printf 's/\302\240//g')" \
		-e "$(printf 's/\341\232\200//g')" \
		-e "$(printf 's/\342\200[\200-\212\250\251\257]//g')" \
		-e "$(printf 's/\342\201\237//g')" \
		-e "$(printf 's/\343\200\200//g')" \
		-e "$(printf 's/\357\273\277//g')")" ]
}

for name in MAPLE_LOCAL_INGEST_KEY MAPLE_LOCAL_ACCESS_TOKEN; do
	value=""
	eval "value=\${$name:-}"
	if is_blank "$value"; then
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
# `--in-memory` has no store to recover and refuses the policy flag.
in_memory=0
for arg in "$@"; do
	[ "$arg" = "--in-memory" ] && in_memory=1
done
if [ "$in_memory" = 1 ]; then
	set -- /opt/maple/maple start --host 0.0.0.0 --port "${PORT:-4318}" --offline "$@"
else
	set -- /opt/maple/maple start --host 0.0.0.0 --port "${PORT:-4318}" --offline \
		--on-dirty-store "$on_dirty_store" "$@"
fi

if [ "$(id -u)" = 0 ]; then
	# Platform volumes are often mounted root-owned: hand them to the server user, then drop root.
	# -h and -xdev: never follow a link or another mount out of the volume.
	find /data -xdev \( ! -user "$MAPLE_UID" -o ! -group "$MAPLE_UID" \) -exec chown -h "$MAPLE_UID:$MAPLE_UID" {} +
	exec setpriv --reuid="$MAPLE_UID" --regid="$MAPLE_UID" --clear-groups --inh-caps=-all \
		--bounding-set=-all --no-new-privs "$@"
fi
exec "$@"
