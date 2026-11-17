/** profile_hotspots end to end through the tool executor, on a fake warehouse holding profile rows. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest"
import { Schema, String as Str } from "effect"
import { ProfileHotspotsOutput } from "@maple/domain/mcp-outputs"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"

const TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"
const MS = 1_000_000

const sqlSeen: string[] = []
let sampleTypeRows: ReadonlyArray<Record<string, unknown>> = []
let stackRows: ReadonlyArray<Record<string, unknown>> = []

const isProfilesRead = (sql: string) => /\bFROM profiles\b/.test(sql)

const fixtures: FixtureRule[] = [
	{
		match: (sql) =>
			isProfilesRead(sql) && Str.includes("groupUniqArray")(sql) && (sqlSeen.push(sql), true),
		rows: () => sampleTypeRows,
	},
	{
		match: (sql) => isProfilesRead(sql) && Str.includes("OVER ()")(sql) && (sqlSeen.push(sql), true),
		rows: () => stackRows,
	},
]

const stack = (hash: string, frames: ReadonlyArray<string>, value: number, totalStacks = 3) => ({
	stackHash: hash,
	frames,
	files: frames.map((frame) => `src/${frame}.ts`),
	lines: frames.map(() => 10),
	value,
	samples: 1,
	totalValue: 1000 * MS,
	totalStacks,
})

/** A wall profile heavier than the CPU one, so the default has to prefer cpu on name, not weight. */
const SAMPLE_TYPES = [
	{
		sampleType: "wall",
		sampleUnit: "nanoseconds",
		value: 5000 * MS,
		samples: 50,
		profiles: 4,
		durationNano: 2000 * MS,
	},
	{
		sampleType: "cpu",
		sampleUnit: "nanoseconds",
		value: 1000 * MS,
		samples: 10,
		profiles: 4,
		durationNano: 2000 * MS,
	},
]

const STACKS = [
	stack("1", ["main", "handle", "parse"], 600 * MS),
	stack("2", ["main", "handle", "serialize"], 300 * MS),
	stack("3", ["main", "gc"], 100 * MS),
]

let rt: EvalRuntime
const run = (params: Record<string, unknown>) => runToolDirect(rt, "profile_hotspots", params)

beforeAll(() => {
	installFakeWarehouse(fixtures)
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

beforeEach(() => {
	sqlSeen.length = 0
	sampleTypeRows = SAMPLE_TYPES
	stackRows = STACKS
})

// Each test reads its own service: reads are cached by scope, as in the real runtime.
describe("profile_hotspots", () => {
	it("reads cpu by default and ranks functions by their own time", async () => {
		const result = await run({ service: "scraper" })
		const output = Schema.decodeUnknownSync(ProfileHotspotsOutput)(result.structuredContent)

		expect(output.sampleType).toBe("cpu")
		expect(output.functions.map((fn) => [fn.name, fn.self / MS, fn.total / MS])).toEqual([
			["parse", 600, 600],
			["serialize", 300, 300],
			["gc", 100, 100],
			["main", 0, 1000],
			["handle", 0, 900],
		])
		const stacksSql = sqlSeen.find((sql) => Str.includes("OVER ()")(sql)) ?? ""
		expect(stacksSql).toContain("'cpu'")
		expect(stacksSql).toContain("'scraper'")

		const text = markdown(result)
		expect(text).toMatch(/\| parse \| 600ms \| 60\.00% \| 600ms \| 60\.00% \| src\/parse\.ts:10 \|/)
		// 1s of CPU over 2s of profiled windows.
		expect(text).toMatch(/\| cpu \| 1\.00s \| 0\.50 \| 4 \|/)
		// The other sample type is one call away.
		expect(text).toMatch(/profile_hotspots.*sample_type.*wall/)
	})

	it("reads the sample type it is asked for", async () => {
		await run({ service: "wall-reader", sample_type: "wall" })
		const stacksSql = sqlSeen.find((sql) => Str.includes("OVER ()")(sql)) ?? ""
		expect(stacksSql).toContain("'wall'")
	})

	it("names the sample types present when the asked one is missing", async () => {
		const result = await run({ service: "no-allocs", sample_type: "alloc_space" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("wall, cpu")
		expect(sqlSeen.some((sql) => Str.includes("OVER ()")(sql))).toBe(false)
	})

	it("scopes both reads to the trace and points at it", async () => {
		const result = await run({ service: "traced", trace_id: TRACE_ID })
		expect(sqlSeen).toHaveLength(2)
		for (const sql of sqlSeen) expect(sql).toContain(TRACE_ID)
		const text = markdown(result)
		expect(text).toContain("inspect_trace")
		// A trace's samples over whole profile windows are not a core count.
		expect(text).toMatch(/\| cpu \| 1\.00s \| — \| 4 \|/)
	})

	it("explains an empty result instead of reading stacks", async () => {
		sampleTypeRows = []
		const result = await run({ service: "idle-worker" })
		const output = Schema.decodeUnknownSync(ProfileHotspotsOutput)(result.structuredContent)
		expect(output.functions).toEqual([])
		expect(sqlSeen).toHaveLength(1)
		const text = markdown(result)
		expect(text).toContain("No profiles from idle-worker")
		expect(text).toContain("plan lacks profiles")
	})

	it("says when the stack cap cut stacks off", async () => {
		stackRows = STACKS.map((row) => ({ ...row, totalStacks: 4000 }))
		const result = await run({ service: "busy-api" })
		const output = Schema.decodeUnknownSync(ProfileHotspotsOutput)(result.structuredContent)
		expect(output.truncated).toBe(true)
		expect(markdown(result)).toContain("heaviest stacks of 4K")
	})
})
