#!/usr/bin/env bun
/**
 * Design-token drift guard.
 *
 * packages/ui/src/styles/tokens.css is the single source of truth for the
 * shared design tokens (see DESIGN.md "Token source of truth"). This script
 * fails if apps/web, apps/landing or apps/local-ui re-declare any token name defined there —
 * the exact duplication that let the landing page drift out of sync with the
 * product. App-local tokens (web's --sh-*, landing's --bg-elevated family)
 * are fine because they aren't declared in the shared file.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { HTTP_METHOD_HEX } from "../packages/ui/src/lib/http"

const root = join(import.meta.dir, "..")
const sharedFile = join(root, "packages/ui/src/styles/tokens.css")

const DECL_RE = /^\s*(--[\w-]+)\s*:/gm

const sharedTokens = new Set<string>()
for (const match of readFileSync(sharedFile, "utf8").matchAll(DECL_RE)) {
	sharedTokens.add(match[1])
}
if (sharedTokens.size === 0) {
	console.error(`No token declarations found in ${sharedFile} — is the file intact?`)
	process.exit(1)
}

const SCAN_ROOTS = ["apps/web/src", "apps/landing/src", "apps/local-ui/src"]
const SCAN_EXT = /\.(css|astro)$/

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry)
		if (statSync(path).isDirectory()) yield* walk(path)
		else if (SCAN_EXT.test(entry)) yield path
	}
}

const violations: string[] = []
for (const scanRoot of SCAN_ROOTS) {
	for (const file of walk(join(root, scanRoot))) {
		const lines = readFileSync(file, "utf8").split("\n")
		lines.forEach((line, i) => {
			for (const match of line.matchAll(DECL_RE)) {
				if (sharedTokens.has(match[1])) {
					violations.push(`${relative(root, file)}:${i + 1}  re-declares ${match[1]}`)
				}
			}
		})
	}
}

if (violations.length > 0) {
	console.error(
		"Shared design tokens re-declared outside packages/ui/src/styles/tokens.css.\n" +
			"Edit the shared file instead (both apps import it):\n",
	)
	for (const v of violations) console.error(`  ${v}`)
	process.exit(1)
}

// Charts and the mobile app read HTTP_METHOD_HEX; the badges read the `--http-*` tokens. Every
// method needs its token, at the same value.
const methodTokens = new Map(
	[...readFileSync(sharedFile, "utf8").matchAll(/^\s*--http-([a-z]+)\s*:\s*([^;]+);/gm)].map(
		([, method, value]) => [method.toUpperCase(), value.trim().toLowerCase()],
	),
)
const methodDrift = Object.entries(HTTP_METHOD_HEX).filter(
	([method, hex]) => methodTokens.get(method) !== hex.toLowerCase(),
)
if (methodDrift.length > 0) {
	console.error("--http-* tokens in tokens.css differ from HTTP_METHOD_HEX in packages/ui/src/lib/http.ts:\n")
	for (const [method, hex] of methodDrift)
		console.error(`  --http-${method.toLowerCase()}: ${methodTokens.get(method) ?? "missing"} (HTTP_METHOD_HEX: ${hex})`)
	process.exit(1)
}

console.log(`check-token-drift: OK (${sharedTokens.size} shared tokens, no re-declarations)`)
