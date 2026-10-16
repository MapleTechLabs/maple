import { describe, expect, test } from "bun:test"
import {
	affectedWorkspaces,
	discoverWorkspaces,
	MAX_LANES,
	plan,
	type Suite,
	suitesOf,
	TARGET_SECONDS,
	trackedFiles,
	type Workspace,
} from "./plan-tests.ts"

const suite = (name: string, files: number, extra: Partial<Suite> = {}): Suite => ({
	name,
	files,
	vitest: true,
	browserWorkspace: "",
	...extra,
})

// Every suite lands in exactly one lane, or in a complete, contiguous set of shard lanes.
const expectCoverage = (suites: ReadonlyArray<Suite>) => {
	const { include } = plan(suites)
	for (const s of suites) {
		const lanes = include.filter((lane) => lane.filters.includes(s.name))
		const shards = lanes.flatMap((lane) =>
			lane.args.filter((a) => a.startsWith("--shard=")).map((a) => a.slice(8)),
		)
		if (shards.length > 0) {
			expect(shards.toSorted()).toEqual(
				Array.from({ length: shards.length }, (_, i) => `${i + 1}/${shards.length}`).toSorted(),
			)
			expect(lanes.every((lane) => lane.filters.length === 1)).toBe(true)
		} else {
			expect(lanes).toHaveLength(1)
		}
		if (s.vitest) expect(lanes.every((lane) => lane["estimated-seconds"] <= TARGET_SECONDS)).toBe(true)
		else expect(lanes[0]?.["bun-filters"]).toContain(s.name)
	}
	const names = include.map((lane) => lane.name)
	expect(new Set(names).size).toBe(names.length)
	return include
}

describe("plan", () => {
	test("covers the real workspace inventory and its fivefold growth", async () => {
		const files = await trackedFiles()
		const suites = suitesOf(await discoverWorkspaces(files), files)
		expect(suites.map((s) => s.name)).toContain("@maple/backend")
		expect(suites.map((s) => s.name)).not.toContain("@maple/ingest")
		const current = expectCoverage(suites)
		const grown = expectCoverage(suites.map((s) => ({ ...s, files: s.files * 5 })))
		expect(grown.length).toBeGreaterThan(current.length)
		expect(grown.length).toBeLessThanOrEqual(MAX_LANES)
	})

	test("shards a new large workspace and ignores input order", () => {
		const suites = [suite("@new/tests", 500), suite("@new/empty", 0)]
		expectCoverage(suites)
		expect(plan(suites)).toEqual(plan(suites.toReversed()))
	})

	test("packs Bun suites with Vitest suites but marks them for a flagless run", () => {
		const lanes = expectCoverage([
			suite("bun-a", 10, { vitest: false }),
			suite("bun-b", 1, { vitest: false }),
			suite("vitest-a", 1),
		])
		expect(lanes).toHaveLength(1)
		expect(lanes[0]?.filters.toSorted()).toEqual(["bun-a", "bun-b", "vitest-a"])
		expect(lanes[0]?.["bun-filters"].toSorted()).toEqual(["bun-a", "bun-b"])
	})

	test("refuses a matrix past GitHub's job limit", () => {
		expect(() => plan([suite("huge", 100_000)])).toThrow(String(MAX_LANES))
	})

	test("installs a browser on every lane that holds a browser suite", () => {
		const lanes = plan([
			suite("node", 200),
			suite("ui", 200, { browserWorkspace: "packages/ui" }),
			suite("tiny-browser", 2, { browserWorkspace: "packages/browser" }),
			suite("tiny-node", 2),
		]).include
		for (const lane of lanes) {
			const expected = lane.filters.includes("ui")
				? "packages/ui"
				: lane.filters.includes("tiny-browser")
					? "packages/browser"
					: ""
			expect(lane["browser-workspace"]).toBe(expected)
		}
	})
})

describe("affectedWorkspaces", () => {
	const ws = (name: string, directory: string, dependencies: Array<string> = []): Workspace => ({
		name,
		directory,
		dependencies,
		testScript: "vitest run",
		browser: false,
	})
	const workspaces = [
		ws("sdk", "packages/sdk"),
		ws("domain", "packages/domain", ["sdk"]),
		ws("web", "apps/web", ["domain"]),
		ws("api", "apps/api", ["domain"]),
		ws("ingest", "apps/ingest"),
		ws("docs-site", "apps/docs-site"),
	]
	const rootInputs = [["domain", "apps/ingest/src/ai_session/*.rs"]] as const
	const affected = (changed: Array<string>) => {
		const result = affectedWorkspaces(workspaces, changed, rootInputs)
		return result === undefined ? "all" : [...result].toSorted()
	}

	test("adds every transitive dependent of a changed workspace", () => {
		expect(affected(["packages/sdk/src/index.ts"])).toEqual(["api", "domain", "sdk", "web"])
		expect(affected(["apps/web/src/app.tsx"])).toEqual(["web"])
	})

	test("does not confuse a workspace with one whose path it prefixes", () => {
		expect(affected(["apps/docs-site/src/a.ts"])).toEqual(["docs-site"])
	})

	test("follows a test task's repo-root inputs into another workspace", () => {
		expect(affected(["apps/ingest/src/ai_session/claude.rs"])).toEqual(["api", "domain", "ingest", "web"])
		expect(affected(["apps/ingest/src/main.rs"])).toEqual(["ingest"])
	})

	test("plans everything when a file outside every workspace changes", () => {
		expect(affected(["apps/web/src/app.tsx", "alchemy.run.ts"])).toBe("all")
		expect(affected([".github/workflows/ci.yml"])).toBe("all")
	})

	test("ignores docs/ and root markdown, but not markdown a workspace owns", () => {
		expect(affected(["docs/ci-performance.md", "README.md"])).toEqual([])
		expect(affected(["apps/web/content/page.md"])).toEqual(["web"])
	})
})
