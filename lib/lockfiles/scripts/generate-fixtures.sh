#!/usr/bin/env bash
# Regenerates src/__fixtures__ from the real package managers: each fixture holds the lockfile,
# its manifests and expected.json (the tool's own sorted name@version list).
# h2 0.3.17 is yanked, so the cargo fixture pins 0.3.16 (still advisory-affected).
# Usage: bash lib/lockfiles/scripts/generate-fixtures.sh [fixture-name ...]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../src/__fixtures__"
WORK="$(mktemp -d -t maple-lockfiles)"
ONLY=("$@")
export npm_config_ignore_scripts=true YARN_ENABLE_SCRIPTS=0 YARN_ENABLE_TELEMETRY=0 COREPACK_ENABLE_STRICT=0

cap() { perl -e 'alarm shift; exec @ARGV' "$@"; }
log() { printf '== %s\n' "$*" >&2; }
wanted() { [ ${#ONLY[@]} -eq 0 ] && return 0; local n; for n in "${ONLY[@]}"; do [ "$n" = "$1" ] && return 0; done; return 1; }

APP_JSON='{"name":"fx","version":"1.0.0","private":true,"dependencies":{"lodash":"4.17.15","express":"4.17.1"},"devDependencies":{"minimist":"1.2.5"}}'

# $1 dir, $2 dependency spec for the sibling workspace ("*" for npm, "workspace:*" otherwise)
write_workspace() {
	mkdir -p "$1/packages/a" "$1/packages/b"
	printf '%s\n' '{"name":"fx-root","version":"1.0.0","private":true,"workspaces":["packages/*"],"devDependencies":{"minimist":"1.2.5"}}' >"$1/package.json"
	printf '%s\n' '{"name":"@fx/a","version":"1.0.0","dependencies":{"lodash":"4.17.15"},"devDependencies":{"minimist":"1.2.5"}}' >"$1/packages/a/package.json"
	printf '{"name":"@fx/b","version":"1.0.0","dependencies":{"express":"4.17.1","@fx/a":"%s"}}\n' "$2" >"$1/packages/b/package.json"
}

# Copies the lockfile and every package.json (relative paths kept) into the fixture dir.
# $1 project dir, $2 fixture name (kind/variant), $3 lockfile name; expected.json is read from stdin.
save() {
	local dest="$OUT/$2"
	rm -rf "$dest" && mkdir -p "$dest"
	cp "$1/$3" "$dest/$3"
	(cd "$1" && find . -name package.json -not -path '*/node_modules/*' -not -path './.yarn/*') | while read -r f; do
		mkdir -p "$dest/$(dirname "$f")" && cp "$1/$f" "$dest/$f"
	done
	[ -f "$1/pnpm-workspace.yaml" ] && cp "$1/pnpm-workspace.yaml" "$dest/"
	cat >"$dest/expected.json"
	log "$2: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).length)' <"$dest/expected.json") packages"
}

# Turns a tool's listing (stdin) into a sorted, de-duplicated JSON array of name@version.
# Local packages (workspaces, link:/file: versions) are dropped: they are not registry packages.
normalize() {
	node -e '
const mode = process.argv[1]
const text = require("fs").readFileSync(0, "utf8")
const out = new Set()
const local = new Set()
const add = (name, version) => {
	if (!name || !version || /^(link|file|workspace):/.test(version)) return
	out.add(`${name}@${version}`)
}
const splitAt = (s) => { const i = s.lastIndexOf("@"); return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ""] }
const walk = (deps) => {
	for (const [name, node] of Object.entries(deps ?? {})) {
		if (node.resolved?.startsWith("file:")) { local.add(name); walkNode(node); continue }
		add(name, node.version)
		walkNode(node)
	}
}
const walkNode = (n) => { walk(n.dependencies); walk(n.devDependencies); walk(n.optionalDependencies) }
if (mode === "tree") {
	const json = JSON.parse(text)
	for (const project of Array.isArray(json) ? json : [json]) walkNode(project)
} else if (mode === "yarn1") {
	const visit = (t) => { if (t.shadow) return; const [n, v] = splitAt(t.name); add(n, v); (t.children ?? []).forEach(visit) }
	for (const line of text.split("\n").filter(Boolean)) {
		const j = JSON.parse(line)
		if (j.type === "tree") j.data.trees.forEach(visit)
	}
} else if (mode === "berry") {
	for (const line of text.split("\n").filter(Boolean)) {
		const j = JSON.parse(line)
		if (j.value.includes("@workspace:")) continue
		add(j.value.slice(0, j.value.indexOf("@", 1)), j.children.Version)
	}
} else if (mode === "bun") {
	for (const line of text.split("\n")) {
		const m = line.match(/[├└│─\s]+(\S+@\S+)\s*$/)
		if (m) { const [n, v] = splitAt(m[1]); add(n, v) }
	}
} else if (mode === "go") {
	for (const line of text.split("\n")) {
		const parts = line.trim().split(/\s+/)
		if (parts.length < 2) continue
		const arrow = parts.indexOf("=>")
		if (arrow === -1) add(parts[0], parts[1])
		else if (parts.length - arrow === 3) add(parts[arrow + 1], parts[arrow + 2])
	}
} else if (mode === "gomodedit") {
	const j = JSON.parse(text)
	for (const r of j.Require ?? []) {
		const rep = (j.Replace ?? []).find((x) => x.Old.Path === r.Path && (!x.Old.Version || x.Old.Version === r.Version))
		if (!rep) add(r.Path, r.Version)
		else if (rep.New.Version) add(rep.New.Path, rep.New.Version)
	}
} else if (mode === "cargo") {
	for (const p of JSON.parse(text).packages) if (p.source && p.source.startsWith("registry+")) add(p.name, p.version)
}
console.log(JSON.stringify([...out].filter((e) => !local.has(e.slice(0, e.lastIndexOf("@")))).sort(), null, "\t"))
' "$1"
}

# $1 fixture name, $2 npm command (e.g. "npx -y npm@6"), $3 "app" or "workspace"
npm_fixture() {
	wanted "$1" || return 0
	local dir="$WORK/${1//\//-}" npm=($2)
	mkdir -p "$dir"
	if [ "$3" = workspace ]; then write_workspace "$dir" "*"; else printf '%s\n' "$APP_JSON" >"$dir/package.json"; fi
	# npm 6 cannot list from the lockfile alone, so it installs; newer npm lists without node_modules.
	if [ "${npm[*]}" = "npx -y npm@6" ]; then
		(cd "$dir" && cap 150 "${npm[@]}" install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1)
		(cd "$dir" && cap 60 "${npm[@]}" ls --json 2>/dev/null || true) | normalize tree | save "$dir" "$1" package-lock.json
	else
		(cd "$dir" && cap 150 "${npm[@]}" install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null 2>&1)
		(cd "$dir" && cap 60 "${npm[@]}" ls --package-lock-only --all --json 2>/dev/null || true) | normalize tree | save "$dir" "$1" package-lock.json
	fi
}

# $1 fixture name, $2 pnpm command, $3 "app" or "workspace". pnpm list reads node_modules, so it installs.
pnpm_fixture() {
	wanted "$1" || return 0
	local dir="$WORK/${1//\//-}" pnpm=($2)
	mkdir -p "$dir"
	if [ "$3" = workspace ]; then
		write_workspace "$dir" "workspace:*"
		printf 'packages:\n  - "packages/*"\n' >"$dir/pnpm-workspace.yaml"
	else printf '%s\n' "$APP_JSON" >"$dir/package.json"; fi
	(cd "$dir" && cap 150 "${pnpm[@]}" install --ignore-scripts >/dev/null 2>&1)
	(cd "$dir" && cap 60 "${pnpm[@]}" list -r --depth Infinity --json 2>/dev/null) | normalize tree | save "$dir" "$1" pnpm-lock.yaml
}

yarn1_fixture() {
	wanted "$1" || return 0
	local dir="$WORK/${1//\//-}" yarn=(npx -y yarn@1.22.22)
	mkdir -p "$dir" && printf '%s\n' "$APP_JSON" >"$dir/package.json"
	(cd "$dir" && cap 150 "${yarn[@]}" install --ignore-scripts --non-interactive >/dev/null 2>&1)
	(cd "$dir" && cap 60 "${yarn[@]}" list --json 2>/dev/null) | normalize yarn1 | save "$dir" "$1" yarn.lock
}

# typescript (dev) makes berry write a builtin patch: entry, which the parser must resolve to npm.
berry_fixture() {
	wanted "$1" || return 0
	local dir="$WORK/${1//\//-}"
	mkdir -p "$dir"
	printf '%s\n' '{"name":"fx","version":"1.0.0","private":true,"dependencies":{"lodash":"4.17.15","express":"4.17.1"},"devDependencies":{"minimist":"1.2.5","typescript":"5.4.5"}}' >"$dir/package.json"
	(cd "$dir" && touch yarn.lock && printf 'nodeLinker: node-modules\nenableGlobalCache: false\n' >.yarnrc.yml)
	(cd "$dir" && cap 150 yarn install --mode=update-lockfile >/dev/null 2>&1)
	(cd "$dir" && cap 60 yarn info -AR --json 2>/dev/null) | normalize berry | save "$dir" "$1" yarn.lock
}

# $1 fixture name, $2 "app" or "workspace"
bun_fixture() {
	wanted "$1" || return 0
	local dir="$WORK/${1//\//-}"
	mkdir -p "$dir"
	if [ "$2" = workspace ]; then write_workspace "$dir" "workspace:*"; else printf '%s\n' "$APP_JSON" >"$dir/package.json"; fi
	(cd "$dir" && cap 150 bun install --ignore-scripts >/dev/null 2>&1)
	(cd "$dir" && cap 60 bun pm ls --all 2>/dev/null) | normalize bun | save "$dir" "$1" bun.lock
}

go_fixture() {
	wanted go-mod/basic || wanted go-sum/basic || return 0
	local dir="$WORK/go"
	mkdir -p "$dir"
	# The replace pins x/text to another version so the fixture exercises module-to-module replacement.
	printf "module example.com/fx\n\ngo 1.21\n\nrequire (\n\tgolang.org/x/net v0.7.0\n\tgithub.com/gin-gonic/gin v1.9.0\n)\n\nreplace golang.org/x/text => golang.org/x/text v0.8.0\n" >"$dir/go.mod"
	printf 'package main\n\nimport (\n\t_ "github.com/gin-gonic/gin"\n\t_ "golang.org/x/net/html"\n)\n\nfunc main() {}\n' >"$dir/main.go"
	(cd "$dir" && GOFLAGS=-mod=mod cap 150 go mod tidy >/dev/null 2>&1)
	local listing
	listing="$(cd "$dir" && cap 60 go list -m all)"
	# expected.json is go's own reading of go.mod; module-graph.json the full graph (go list -m all), a superset.
	(cd "$dir" && go mod edit -json) | normalize gomodedit | save "$dir" go-mod/basic go.mod
	printf '%s\n' "$listing" | normalize go >"$OUT/go-mod/basic/module-graph.json"
	printf '%s\n' "$listing" | normalize go | save "$dir" go-sum/basic go.sum
}

cargo_fixture() {
	wanted cargo-lock/basic || return 0
	local dir="$WORK/cargo"
	mkdir -p "$dir/src"
	printf '[package]\nname = "fx"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\ntime = "=0.1.43"\nh2 = "=0.3.16"\n' >"$dir/Cargo.toml"
	printf 'fn main() {}\n' >"$dir/src/main.rs"
	(cd "$dir" && cap 150 cargo generate-lockfile >/dev/null 2>&1)
	(cd "$dir" && cap 60 cargo metadata --format-version 1 2>/dev/null) | normalize cargo | save "$dir" cargo-lock/basic Cargo.lock
	cp "$dir/Cargo.toml" "$OUT/cargo-lock/basic/"
}

npm_fixture package-lock/v1 "npx -y npm@6" app
npm_fixture package-lock/v2 "npx -y npm@8" app
npm_fixture package-lock/v3 "npm" app
npm_fixture package-lock/workspace "npm" workspace
pnpm_fixture pnpm-lock/v5 "npx -y pnpm@7.33.7" app
pnpm_fixture pnpm-lock/v6 "npx -y pnpm@8.15.9" app
pnpm_fixture pnpm-lock/v9 "pnpm" app
pnpm_fixture pnpm-lock/workspace "pnpm" workspace
yarn1_fixture yarn-v1/basic
berry_fixture yarn-berry/basic
bun_fixture bun-lock/basic app
bun_fixture bun-lock/workspace workspace
go_fixture
cargo_fixture
rm -rf "$WORK"
