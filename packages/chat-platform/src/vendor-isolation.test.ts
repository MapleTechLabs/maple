/**
 * The rule this package exists for, as a test.
 *
 * Everything that differs between one chat vendor and the next lives in
 * `src/connectors/<id>/`. Nothing else — not the contract, not the host Worker,
 * not the infrastructure wiring — may name a vendor, in code, in a comment, in a
 * type or in a file name. A customer adds a platform by adding a directory and a
 * line to the registry; every vendor name that leaks out of a connector
 * directory is one more place they would have to edit.
 *
 * The one exception is the registry's own import and array, because naming the
 * connector is what registering it is.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const PACKAGE_SRC = fileURLToPath(new URL(".", import.meta.url))
const REPO_ROOT = join(PACKAGE_SRC, "..", "..", "..")

/** Add a root here when new vendor-neutral code is written; keep them repo-relative. */
const GUARDED_ROOTS = ["packages/chat-platform/src", "apps/chat-bot/src"]

/** Case-insensitive. Extend as connectors land — the guard only guards what it knows. */
const VENDORS = ["discord", "slack", "teams", "telegram", "whatsapp"]

const REGISTRY = join("packages", "chat-platform", "src", "connectors", "index.ts")
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url))

/** Where vendor names belong: a connector's own directory, and this guard's own list. */
const isExempt = (repoRelativePath: string): boolean => {
	if (repoRelativePath === SELF) return true
	const segments = repoRelativePath.split(sep)
	const index = segments.indexOf("connectors")
	// `connectors/<id>/...` — a connector's own directory.
	return index !== -1 && segments.length > index + 2
}

/** The registry's import and its array: naming the connector is what registering it is. */
const REGISTRATION_LINE = /^\s*(import\b|export const connectors\b)/u

const sourceFiles = (root: string): ReadonlyArray<string> => {
	const absolute = join(REPO_ROOT, root)
	if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) return []
	const walk = (dir: string): ReadonlyArray<string> =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) return walk(path)
			return entry.isFile() ? [path] : []
		})
	return walk(absolute).map((path) => relative(REPO_ROOT, path))
}

const offendingLines = (repoRelativePath: string): ReadonlyArray<string> => {
	const isRegistry = repoRelativePath === REGISTRY
	return readFileSync(join(REPO_ROOT, repoRelativePath), "utf8")
		.split("\n")
		.filter((line) => {
			const lower = line.toLowerCase()
			if (!VENDORS.some((vendor) => lower.includes(vendor))) return false
			// The registry may name a connector where it registers it, and nowhere else.
			return !(isRegistry && REGISTRATION_LINE.test(line))
		})
		.map((line) => `${repoRelativePath}: ${line.trim()}`)
}

describe("vendor isolation", () => {
	it("keeps every vendor name inside its own connector directory", () => {
		const offenders = GUARDED_ROOTS.flatMap(sourceFiles)
			.filter((path) => !isExempt(path))
			.flatMap(offendingLines)
		expect(offenders).toEqual([])
	})

	it("keeps vendor names out of file names too", () => {
		const offenders = GUARDED_ROOTS.flatMap(sourceFiles).filter((path) => {
			if (isExempt(path)) return false
			const segments = path.split(sep)
			const index = segments.indexOf("connectors")
			// `connectors/<id>` is the directory itself — its name IS the id.
			const named = index === -1 ? segments : segments.slice(index + 2)
			return named.some((segment) =>
				VENDORS.some((vendor) => segment.toLowerCase().includes(vendor)),
			)
		})
		expect(offenders).toEqual([])
	})
})
