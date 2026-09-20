import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The rule this package exists to keep: everything that distinguishes one chat
 * platform from another lives in `src/connectors/<id>/`. A platform named
 * anywhere else — a column, a route, a component, a test fixture — is a seam
 * that the next connector would have to widen, so it fails here instead.
 *
 * The two registry files are exempt: naming the connectors is their whole job.
 * Tests outside a connector directory use a fake connector, `testchat`.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url))

/** Every vendor whose name must not leak. Extend as connectors are added. */
const VENDORS = ["discord", "slack", "teams", "telegram", "whatsapp"]

/**
 * The vendor-neutral files this feature owns. A new generic file — a service,
 * a route, a component — belongs on this list; that is what makes the guard
 * cover it.
 */
const GUARDED_PATHS: ReadonlyArray<string> = [
	"packages/chat-platform/src",
	"packages/db/src/schema/chat-workspaces.ts",
	"packages/domain/src/http/v2/integrations-chat.ts",
	"packages/backend/src/services/integrations/ChatWorkspaceService.ts",
	"apps/api/src/routes/v2/integrations-chat.http.ts",
	"apps/api/src/routes/v1/chat-integration.http.ts",
	"apps/web/src/components/integrations/chat-integration-card.tsx",
]

/**
 * Files allowed to name a connector: the two registries, whose job it is, and
 * this guard, which holds the list of names to look for.
 */
const EXEMPT_FILES: ReadonlyArray<string> = [
	join("packages", "chat-platform", "src", "connectors", "index.ts"),
	join("packages", "chat-platform", "src", "connectors", "manifests.ts"),
	join("packages", "chat-platform", "src", "vendor-isolation.test.ts"),
]

const CONNECTOR_DIR = join("packages", "chat-platform", "src", "connectors") + sep

const isInsideConnector = (path: string): boolean => {
	if (!path.startsWith(CONNECTOR_DIR)) return false
	// `connectors/<id>/…` is a connector's own ground; `connectors/<file>` is not.
	return path.slice(CONNECTOR_DIR.length).includes(sep)
}

const collectFiles = (absolute: string): ReadonlyArray<string> => {
	const stats = statSync(absolute, { throwIfNoEntry: false })
	if (stats === undefined) return []
	if (!stats.isDirectory()) return [absolute]
	return readdirSync(absolute).flatMap((entry) => collectFiles(join(absolute, entry)))
}

describe("chat platform vendor isolation", () => {
	it("names no chat platform outside its own connector directory", () => {
		const offenders: Array<string> = []
		for (const guarded of GUARDED_PATHS) {
			for (const absolute of collectFiles(join(REPO_ROOT, guarded))) {
				const path = relative(REPO_ROOT, absolute)
				if (isInsideConnector(path) || EXEMPT_FILES.includes(path)) continue
				const contents = readFileSync(absolute, "utf8").toLowerCase()
				for (const vendor of VENDORS) {
					if (contents.includes(vendor)) offenders.push(`${path}: ${vendor}`)
				}
			}
		}
		expect(offenders).toEqual([])
	})

	it("guards files that exist", () => {
		const missing = GUARDED_PATHS.filter(
			(guarded) => statSync(join(REPO_ROOT, guarded), { throwIfNoEntry: false }) === undefined,
		)
		expect(missing).toEqual([])
	})
})
