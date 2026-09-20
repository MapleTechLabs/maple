/**
 * The rule the package exists for, checked rather than trusted.
 *
 * Nothing outside a connector's own directory may name a chat vendor — not an identifier, not a
 * string, not a comment, not a test fixture, and not a FILE NAME. The one exception is the
 * registry, which has to import the connectors it registers.
 *
 * A source scan rather than a convention because the drift this prevents is invisible in review:
 * one platform's name in a shared type, a route or a column, and adding the next platform stops
 * being a directory and a line.
 */
import { readdirSync, readFileSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))

/** Trees that must stay vendor-neutral. A new surface that drives connectors is added here. */
const GUARDED_ROOTS = ["packages/chat-platform/src", "apps/chat-bot/src"]

const VENDORS = ["discord", "slack", "teams", "telegram", "whatsapp"]

const SELF = fileURLToPath(import.meta.url)

const sourcesUnder = (dir: string): Array<string> =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name)
		// A directory whose parent is `connectors` IS a connector: everything in it is vendor code.
		if (entry.isDirectory()) return basename(dir) === "connectors" ? [] : sourcesUnder(full)
		return entry.name.endsWith(".ts") ? [full] : []
	})

/** The registry names what it registers; nothing else on those lines does anything else. */
const isRegistration = (line: string): boolean =>
	line.startsWith("import ") || line.includes("export const connectors")

describe("vendor isolation", () => {
	/**
	 * Without this the guard can pass by reading nothing. `sourcesUnder` throws on a root that has
	 * been moved, but a root that survives as an empty directory would leave every check below
	 * iterating an empty list — green, and enforcing nothing.
	 */
	it("actually reads every root it guards", () => {
		for (const root of GUARDED_ROOTS) {
			expect(sourcesUnder(join(repoRoot, root)).length, `${root} has no sources`).toBeGreaterThan(0)
		}
	})

	for (const root of GUARDED_ROOTS) {
		it(`keeps ${root} free of vendor names`, () => {
			const registry = join(repoRoot, root, "connectors", "index.ts")
			const offenders: Array<string> = []

			for (const file of sourcesUnder(join(repoRoot, root))) {
				if (file === SELF) continue
				const lines = readFileSync(file, "utf8").split("\n")
				lines.forEach((line, index) => {
					const lowered = line.toLowerCase()
					if (!VENDORS.some((vendor) => lowered.includes(vendor))) return
					if (file === registry && isRegistration(line)) return
					offenders.push(`${relative(repoRoot, file)}:${index + 1}: ${line.trim()}`)
				})
			}

			expect(offenders).toEqual([])
		})

		/**
		 * A connector DIRECTORY is exempt, so `sourcesUnder` never descends into it — but a loose
		 * file beside those directories is not, and its contents alone would not catch a name that
		 * lives only in the file name. `connectors/<vendor>-helpers.ts` is the case.
		 */
		it(`keeps ${root} free of vendor file names`, () => {
			const offenders = sourcesUnder(join(repoRoot, root))
				.filter((file) => file !== SELF)
				.filter((file) => {
					const name = basename(file).toLowerCase()
					return VENDORS.some((vendor) => name.includes(vendor))
				})
				.map((file) => relative(repoRoot, file))

			expect(offenders).toEqual([])
		})
	}
})
