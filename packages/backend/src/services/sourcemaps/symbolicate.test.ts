import { TraceMap } from "@jridgewell/trace-mapping"
import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { symbolicateStack } from "./symbolicate"

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** Base64 VLQ, as the source map v3 spec encodes each segment field. */
const vlq = (value: number): string => {
	const digits = (rest: number): ReadonlyArray<number> =>
		rest < 32 ? [rest] : [(rest & 31) | 32, ...digits(rest >>> 5)]
	return Arr.join(
		Arr.map(digits(value < 0 ? (-value << 1) | 1 : value << 1), (digit) => BASE64[digit] ?? ""),
		"",
	)
}

type Segment = readonly [genColumn: number, source: number, line: number, column: number, name?: number]

/** Encodes one generated line of absolute (0-based) segments into a `mappings` string. */
const encodeLine = (segments: ReadonlyArray<Segment>): string =>
	Arr.join(
		Arr.map(segments, (segment, i) => {
			const before = Arr.take(segments, i)
			const previous = Arr.last(before)
			const delta = (field: 0 | 1 | 2 | 3) =>
				segment[field] - (previous._tag === "Some" ? previous.value[field] : 0)
			const fields = [delta(0), delta(1), delta(2), delta(3)]
			const previousName = Arr.reduce(before, 0, (acc, s) => s[4] ?? acc)
			const named = segment[4] === undefined ? fields : [...fields, segment[4] - previousName]
			return Arr.join(Arr.map(named, vlq), "")
		}),
		",",
	)

const APP_SOURCE = Arr.join(
	Arr.makeBy(14, (i) => `// app line ${i + 1}`),
	"\n",
)

// Generated line 1 of assets/index-Bx81.js:
//   col 0  -> src/app.ts 7:0 named handleClick (the minified `a`)
//   col 15 -> src/app.ts 9:9
//   col 30 -> node_modules/lib/index.js 2:4
const appMap = new TraceMap({
	version: 3,
	file: "index-Bx81.js",
	sources: ["webpack://my-app/./src/app.ts", "webpack://my-app/./node_modules/lib/index.js"],
	sourcesContent: [APP_SOURCE, null],
	names: ["handleClick"],
	mappings: encodeLine([
		[0, 0, 6, 0, 0],
		[15, 0, 8, 9],
		[30, 1, 1, 4],
	]),
})

// sourceRoot plus a relative source.
const chunkMap = new TraceMap({
	version: 3,
	sourceRoot: "webpack://my-app/",
	sources: ["./src/chunk.ts"],
	names: [],
	mappings: encodeLine([[0, 0, 2, 2]]),
})

const APP_URL = "https://app.example.com/assets/index-Bx81.js"
const CHUNK_URL = "https://app.example.com/assets/chunk-9a.js"
const UNMAPPED_URL = "https://app.example.com/assets/vendor-77.js"

const lookup = (frame: { readonly url: string | null }) =>
	frame.url === APP_URL ? appMap : frame.url === CHUNK_URL ? chunkMap : undefined

describe("symbolicateStack", () => {
	it("maps a minified frame back to the original file and context", () => {
		const result = symbolicateStack(`TypeError: boom\n    at a (${APP_URL}:1:1)`, lookup)
		expect(result.status).toBe("resolved")
		expect(result.missing).toEqual([])
		expect(result.frames).toEqual([
			{
				raw: `at a (${APP_URL}:1:1)`,
				// No caller frame names it, so the minified name stays.
				function: "a",
				file: "src/app.ts",
				line: 7,
				column: 1,
				in_app: true,
				resolved: true,
				context: {
					pre: [
						"// app line 2",
						"// app line 3",
						"// app line 4",
						"// app line 5",
						"// app line 6",
					],
					line: "// app line 7",
					post: [
						"// app line 8",
						"// app line 9",
						"// app line 10",
						"// app line 11",
						"// app line 12",
					],
				},
			},
		])
	})

	it("treats stack columns as 1-based and trace-mapping columns as 0-based", () => {
		// 1-based column 16 is generated column 15, the second segment; column 15 still falls in the first.
		const result = symbolicateStack(
			`Error\n    at a (${APP_URL}:1:16)\n    at a (${APP_URL}:1:15)`,
			lookup,
		)
		expect(
			Arr.map(result.frames, (frame) => [frame.function, frame.file, frame.line, frame.column]),
		).toEqual([
			// Named by the caller's call site (the `handleClick` token), not by its own position.
			["handleClick", "src/app.ts", 9, 10],
			["a", "src/app.ts", 7, 1],
		])
		expect(result.frames[0]?.context?.pre.length).toBe(5)
		expect(result.frames[0]?.context?.line).toBe("// app line 9")
	})

	it("does not name a frame after the function it calls", () => {
		const result = symbolicateStack(
			`Error\n    at a (${APP_URL}:1:1)\n    at b (${APP_URL}:1:16)`,
			lookup,
		)
		expect(Arr.map(result.frames, (frame) => frame.function)).toEqual(["a", "b"])
	})

	it("marks dependency frames as not in app and gives no context without sourcesContent", () => {
		const [frame] = symbolicateStack(`Error\n    at c (${APP_URL}:1:31)`, lookup).frames
		expect(frame?.file).toBe("node_modules/lib/index.js")
		expect([frame?.line, frame?.column]).toEqual([2, 5])
		expect(frame?.in_app).toBe(false)
		expect(frame?.resolved).toBe(true)
		expect(frame?.context).toBeNull()
	})

	it("resolves sources against sourceRoot", () => {
		const [frame] = symbolicateStack(`Error\n    at x (${CHUNK_URL}:1:1)`, lookup).frames
		expect([frame?.file, frame?.line, frame?.column]).toEqual(["src/chunk.ts", 3, 3])
	})

	it("reports partial with deduped missing URLs when some frames have no map", () => {
		const result = symbolicateStack(
			Arr.join(
				[
					"Error: boom",
					`    at a (${APP_URL}:1:1)`,
					`    at v (${UNMAPPED_URL}:3:7)`,
					`    at w (${UNMAPPED_URL}:4:1)`,
					"    at Array.map (<anonymous>)",
				],
				"\n",
			),
			lookup,
		)
		expect(result.status).toBe("partial")
		expect(result.missing).toEqual([UNMAPPED_URL])
		expect(result.frames[1]).toEqual({
			raw: `at v (${UNMAPPED_URL}:3:7)`,
			function: "v",
			file: UNMAPPED_URL,
			line: 3,
			column: 7,
			in_app: true,
			resolved: false,
			context: null,
		})
		expect(result.frames[3]?.in_app).toBe(false)
	})

	it("is resolved when only engine and dependency frames stay unmapped, and never lists them", () => {
		const result = symbolicateStack(
			Arr.join(
				[
					"Error: boom",
					`    at a (${APP_URL}:1:1)`,
					"    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
					"    at run (/srv/app/node_modules/lib/index.js:10:3)",
					"    at Module._compile (node:internal/modules/cjs/loader:1256:14)",
				],
				"\n",
			),
			lookup,
		)
		expect(result.status).toBe("resolved")
		expect(result.missing).toEqual([])
	})

	it("symbolicates Firefox frames", () => {
		const result = symbolicateStack(`a@${APP_URL}:1:16\n@${UNMAPPED_URL}:1:1`, lookup)
		expect(result.status).toBe("partial")
		expect(
			Arr.map(result.frames, (frame) => [frame.function, frame.file, frame.line, frame.column]),
		).toEqual([
			["a", "src/app.ts", 9, 10],
			[null, UNMAPPED_URL, 1, 1],
		])
	})

	it("is missing_map when no frame resolves and not_applicable for non-JS stacks", () => {
		expect(symbolicateStack(`Error\n    at v (${UNMAPPED_URL}:3:7)`, lookup).status).toBe("missing_map")
		const python = symbolicateStack('Traceback (most recent call last):\n  File "a.py", line 1', lookup)
		expect(python).toEqual({ status: "not_applicable", frames: [], missing: [] })
	})

	it("keeps a mapped position whose source text the map leaves out", () => {
		const short = new TraceMap({
			version: 3,
			sources: ["src/app.ts"],
			sourcesContent: [],
			names: [],
			mappings: "AAAA",
		})
		const result = symbolicateStack(`Error\n    at a (${APP_URL}:1:1)`, () => short)
		expect(Arr.map(result.frames, (frame) => [frame.file, frame.line, frame.context])).toEqual([
			["src/app.ts", 1, null],
		])
	})

	it("leaves a zero-line frame raw and still maps the rest", () => {
		const result = symbolicateStack(`Error\n    at a (${APP_URL}:1:1)\n    at b (${APP_URL}:0:1)`, lookup)
		expect(Arr.map(result.frames, (frame) => frame.resolved)).toEqual([true, false])
	})

	it("counts a locationless engine frame out of app", () => {
		const result = symbolicateStack(
			`Error\n    at a (${APP_URL}:1:1)\n    at processTick (native)`,
			lookup,
		)
		expect(Arr.map(result.frames, (frame) => frame.in_app)).toEqual([true, false])
	})

	it("counts a source in the map's ignoreList out of app, still resolved", () => {
		const ignoring = new TraceMap({
			version: 3,
			sources: ["src/framework.js"],
			names: [],
			mappings: "AAAA",
			ignoreList: [0],
		})
		const [frame] = symbolicateStack(`Error\n    at a (${APP_URL}:1:1)`, () => ignoring).frames
		expect([frame?.file, frame?.resolved, frame?.in_app]).toEqual(["src/framework.js", true, false])
	})

	it("does not name a frame after the frame below a Promise combinator", () => {
		// b's position maps to a call of handleClick, but b called Promise.all, not a: a keeps its name.
		const result = symbolicateStack(
			`Error\n    at a (${APP_URL}:1:1)\n    at async Promise.all (index 0)\n    at async b (${APP_URL}:1:1)`,
			lookup,
		)
		expect(Arr.map(result.frames, (frame) => [frame.function, frame.in_app])).toEqual([
			["a", true],
			["Promise.all", false],
			["b", true],
		])
	})
})
