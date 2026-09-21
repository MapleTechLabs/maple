/**
 * The rule the package exists for, checked rather than trusted.
 *
 * Nothing outside a connector's own directory may name a chat vendor — not an identifier, not a
 * string, not a comment, not a test fixture, and not a FILE NAME. The exceptions are the two
 * registries, which have to name what they register. Tests outside a connector directory use a
 * fake connector, `testchat`.
 *
 * A source scan rather than a convention because the drift this prevents is invisible in review:
 * one platform's name in a shared type, a route or a column, and adding the next platform stops
 * being a directory and a line.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))

/** Trees that must stay vendor-neutral. A new surface that drives connectors is added here. */
const GUARDED_ROOTS = ["packages/chat-platform/src", "apps/chat-bot/src"]

/**
 * The vendor-neutral files this feature owns elsewhere in the repo: the table, the public contract,
 * the service that drives an install, both routes and the dashboard card. A new generic file
 * belongs on this list; that is what makes the guard cover it.
 */
const GUARDED_FILES = [
	"packages/db/src/schema/chat-workspaces.ts",
	"packages/domain/src/http/v2/integrations-chat.ts",
	"packages/backend/src/services/integrations/ChatWorkspaceService.ts",
	"packages/backend/src/services/integrations/ChatWorkspaceService.test.ts",
	"packages/backend/src/services/integrations/chat-workspace-rows.ts",
	"apps/api/src/routes/v2/integrations-chat.http.ts",
	"apps/api/src/routes/v1/chat-integration.http.ts",
	"apps/web/src/components/integrations/chat-integration-card.tsx",
]

/**
 * Files this feature only *touched*, which name a vendor for reasons that predate it — the
 * integrations catalog has carried a Slack card for a year. They stay guarded against every OTHER
 * vendor, which is what stops a `connector === "…"` branch appearing in the generic chat code they
 * now also hold.
 */
const PARTIALLY_GUARDED: ReadonlyArray<{ readonly path: string; readonly allow: ReadonlyArray<string> }> = [
	{ path: "apps/web/src/components/integrations/integration-catalog.tsx", allow: ["slack"] },
	{ path: "apps/web/src/routes/integrations.tsx", allow: ["slack"] },
]

const VENDORS = ["discord", "slack", "teams", "telegram", "whatsapp"]

const SELF = fileURLToPath(import.meta.url)

const sourcesUnder = (dir: string): Array<string> =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name)
		// A directory whose parent is `connectors` IS a connector: everything in it is vendor code.
		if (entry.isDirectory()) return basename(dir) === "connectors" ? [] : sourcesUnder(full)
		return entry.name.endsWith(".ts") ? [full] : []
	})

/** The registries name what they register; nothing else on those lines does anything else. */
const isRegistration = (line: string): boolean =>
	line.startsWith("import ") ||
	line.includes("export const connectors") ||
	line.includes("export const chatConnectorManifests")

const offendingLines = (
	file: string,
	allow: ReadonlyArray<string>,
	exempt: (line: string) => boolean,
): Array<string> => {
	const offenders: Array<string> = []
	readFileSync(file, "utf8")
		.split("\n")
		.forEach((line, index) => {
			const lowered = line.toLowerCase()
			if (!VENDORS.some((vendor) => !allow.includes(vendor) && lowered.includes(vendor))) return
			if (exempt(line)) return
			offenders.push(`${relative(repoRoot, file)}:${index + 1}: ${line.trim()}`)
		})
	return offenders
}

const never = (): boolean => false

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
			const registries = [
				join(repoRoot, root, "connectors", "index.ts"),
				join(repoRoot, root, "connectors", "manifests.ts"),
			]
			const offenders = sourcesUnder(join(repoRoot, root))
				.filter((file) => file !== SELF)
				.flatMap((file) =>
					offendingLines(file, [], registries.includes(file) ? isRegistration : never),
				)

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

	it("keeps the files this feature owns elsewhere free of vendor names", () => {
		const offenders = GUARDED_FILES.flatMap((path) => offendingLines(join(repoRoot, path), [], never))
		expect(offenders).toEqual([])
	})

	it("keeps the shared dashboard files free of every vendor they did not already carry", () => {
		const offenders = PARTIALLY_GUARDED.flatMap((guarded) =>
			offendingLines(join(repoRoot, guarded.path), guarded.allow, never),
		)
		expect(offenders).toEqual([])
	})

	it("guards files that exist", () => {
		const missing = [...GUARDED_FILES, ...PARTIALLY_GUARDED.map((guarded) => guarded.path)].filter(
			(path) => statSync(join(repoRoot, path), { throwIfNoEntry: false }) === undefined,
		)
		expect(missing).toEqual([])
	})
})
