#!/bin/sh
# Maple local-binary uninstaller — the inverse of scripts/install.sh.
#
#   curl -fsSL https://maple.dev/cli/uninstall | sh
#
# Removes the `maple` PATH symlink and the `~/.maple/bin` bundle (maple plus
# its npm chdb runtime sidecar). Your data dir (`~/.maple/data`) and config (`~/.maple/config.json`,
# holding any remote token) are KEPT unless you opt in — the data dir prompts
# (or set MAPLE_REMOVE_DATA=1 for non-interactive removal).
#
# Honors the same overrides as the installer so a custom install can be undone:
#   MAPLE_INSTALL_DIR  bundle directory          (default: ~/.maple/bin)
#   MAPLE_BIN_DIR      where `maple` was linked   (default: search the usual dirs)
#   MAPLE_REMOVE_DATA  set to 1 to also delete ~/.maple/data without prompting
set -eu

INSTALL_DIR="${MAPLE_INSTALL_DIR:-$HOME/.maple/bin}"
DATA_DIR="$HOME/.maple/data"

say() { printf '%s\n' "$*"; }
pretty() { case "$1" in "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }

# Remove `<dir>/maple` only when it is a symlink pointing into our install dir,
# so we never clobber an unrelated `maple` that happens to be on PATH.
remove_link() {
	link="$1/maple"
	[ -L "$link" ] || return 0
	target="$(readlink "$link" 2>/dev/null || true)"
	case "$target" in
		"$INSTALL_DIR"/* | "$INSTALL_DIR")
			rm -f "$link" && say "✓ Removed symlink $(pretty "$link")"
			;;
		*)
			say "• Left $(pretty "$link") (points to $target, not $INSTALL_DIR)"
			;;
	esac
}

if [ -n "${MAPLE_BIN_DIR:-}" ]; then
	remove_link "$MAPLE_BIN_DIR"
else
	for d in /usr/local/bin "$HOME/.local/bin"; do
		remove_link "$d"
	done
fi

if [ -d "$INSTALL_DIR" ]; then
	rm -rf "$INSTALL_DIR"
	say "✓ Removed bundle $(pretty "$INSTALL_DIR")"
else
	say "• No bundle at $(pretty "$INSTALL_DIR")"
fi

# Data dir: keep by default; delete only on explicit opt-in or a y/N confirmation.
if [ -d "$DATA_DIR" ]; then
	remove_data=0
	if [ "${MAPLE_REMOVE_DATA:-0}" = "1" ]; then
		remove_data=1
	elif [ -r /dev/tty ]; then
		printf 'Also delete the data dir %s? [y/N] ' "$(pretty "$DATA_DIR")" >/dev/tty
		read -r ans </dev/tty || ans=""
		case "$ans" in [yY] | [yY][eE][sS]) remove_data=1 ;; esac
	fi
	if [ "$remove_data" = "1" ]; then
		rm -rf "$DATA_DIR"
		say "✓ Removed data dir $(pretty "$DATA_DIR")"
	else
		say "• Kept data dir $(pretty "$DATA_DIR") (set MAPLE_REMOVE_DATA=1 to delete)"
	fi
fi

say ""
say "Maple uninstalled. ~/.maple/config.json (if present) was left in place."
