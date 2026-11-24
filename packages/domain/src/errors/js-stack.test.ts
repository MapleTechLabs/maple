import { Array as Arr, Schema, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import {
	SymbolicatedStack,
	decodeDebugIds,
	isInAppPath,
	parseJsStack,
	urlMatchesMinifiedPath,
} from "./js-stack"

const V8 = `TypeError: Cannot read properties of undefined (reading 'id')
    at handleClick (https://app.example.com/assets/index-Bx81.js:1:2345)
    at https://app.example.com/assets/vendor.js?v=3:12:40
    at async loadUser (https://app.example.com/assets/index-Bx81.js:2:10)
    at new Store (webpack-internal:///./src/store.ts:7:3)
    at eval (eval at compile (https://app.example.com/assets/index-Bx81.js:3:15), <anonymous>:1:1)
    at Array.map (<anonymous>)
    at fiber (#12)
    at myEffectSpan`

describe("parseJsStack", () => {
	it("parses V8 frames top first and keeps the header out of the frames", () => {
		const parsed = parseJsStack(V8)
		expect(parsed.message).toBe("TypeError: Cannot read properties of undefined (reading 'id')")
		expect(
			Arr.map(parsed.frames, (frame) => [frame.function, frame.url, frame.line, frame.column]),
		).toEqual([
			["handleClick", "https://app.example.com/assets/index-Bx81.js", 1, 2345],
			[null, "https://app.example.com/assets/vendor.js?v=3", 12, 40],
			["loadUser", "https://app.example.com/assets/index-Bx81.js", 2, 10],
			["Store", "webpack-internal:///./src/store.ts", 7, 3],
			["eval", "https://app.example.com/assets/index-Bx81.js", 3, 15],
			["Array.map", null, null, null],
		])
		expect(parsed.frames[0]?.raw).toBe(
			"at handleClick (https://app.example.com/assets/index-Bx81.js:1:2345)",
		)
	})

	it("parses Firefox and Safari frames", () => {
		const parsed = parseJsStack(
			Arr.join(
				[
					"render@https://app.example.com/assets/index.js:10:5",
					"@https://app.example.com/assets/index.js:1:1",
					"global code@https://app.example.com/assets/main.js:3:9",
					"[native code]",
					"lazy@https://cdn.example.com/node_modules/@scope/pkg/index.js:4:2",
				],
				"\n",
			),
		)
		expect(parsed.message).toBeNull()
		expect(
			Arr.map(parsed.frames, (frame) => [frame.function, frame.url, frame.line, frame.column]),
		).toEqual([
			["render", "https://app.example.com/assets/index.js", 10, 5],
			[null, "https://app.example.com/assets/index.js", 1, 1],
			["global code", "https://app.example.com/assets/main.js", 3, 9],
			["lazy", "https://cdn.example.com/node_modules/@scope/pkg/index.js", 4, 2],
		])
	})

	it("keeps a Promise combinator frame, with no location, between two app frames", () => {
		const { frames } = parseJsStack(
			"Error: boom\n    at child (https://a.test/app.js:1:5)\n    at async Promise.all (index 0)\n    at async parent (https://a.test/app.js:1:40)",
		)
		expect(Arr.map(frames, (frame) => [frame.function, frame.url])).toEqual([
			["child", "https://a.test/app.js"],
			["Promise.all", null],
			["parent", "https://a.test/app.js"],
		])
	})

	it("parses hostile lines in linear time", () => {
		// Each line is its prefix plus a repeated unit, filled to `length` characters.
		const attackLines = (length: number) =>
			Arr.map(
				[
					["at ", " "],
					["at  (", " (a"],
					["@a", " "],
					["at a (", ":1"],
					["x@", " line 1"],
					["at eval (eval at ", "(("],
				] as const,
				([prefix, unit]) =>
					`${prefix}${Str.repeat(Math.floor((length - prefix.length) / unit.length))(unit)}`,
			)
		// 100k-char lines are past the frame cap; ones just under it go through the whole parser.
		Arr.forEach(attackLines(1_999), (line) => expect(line.length).toBeLessThanOrEqual(2_000))
		Arr.forEach([100_000, 1_999], (length) =>
			Arr.forEach(attackLines(length), (line) => {
				const started = performance.now()
				parseJsStack(`Error: x\n${line}\n${line}`)
				expect(performance.now() - started).toBeLessThan(50)
			}),
		)
	})

	it("reads the concrete location of a nested eval origin", () => {
		const { frames } = parseJsStack(
			"Error\n    at eval (eval at a (eval at b (https://cdn.test/app.js:10:3)), <anonymous>:1:1)",
		)
		expect(Arr.map(frames, (frame) => [frame.function, frame.url, frame.line, frame.column])).toEqual([
			["eval", "https://cdn.test/app.js", 10, 3],
		])
	})

	it("skips caused by lines and returns no frames for a non-JS stack", () => {
		expect(parseJsStack("Error: boom\ncaused by: Error: inner").frames).toEqual([])
		expect(parseJsStack('Traceback (most recent call last):\n  File "a.py", line 1').frames).toEqual([])
		expect(parseJsStack("").message).toBeNull()
	})
})

describe("decodeDebugIds", () => {
	it("reads the JSON object and treats anything else as empty", () => {
		const ids = decodeDebugIds('{"https://a.example/x.js":"0f1e2d3c-0000-4000-8000-000000000001"}')
		expect(ids.get("https://a.example/x.js")).toBe("0f1e2d3c-0000-4000-8000-000000000001")
		expect(decodeDebugIds(undefined).size).toBe(0)
		expect(decodeDebugIds("{not json").size).toBe(0)
		expect(decodeDebugIds('["a"]').size).toBe(0)
		expect(decodeDebugIds('{"a":1}').size).toBe(0)
	})
})

describe("urlMatchesMinifiedPath", () => {
	it.each([
		["https://app.example.com/assets/index-Bx81.js", "assets/index-Bx81.js", true],
		["https://app.example.com/assets/index-Bx81.js?v=2#x", "assets/index-Bx81.js", true],
		["https://app.example.com/base/assets/index-Bx81.js", "assets/index-Bx81.js", true],
		["https://app.example.com/assets/index-Bx81.js", "/assets/index-Bx81.js", true],
		["https://app.example.com/myassets/index-Bx81.js", "assets/index-Bx81.js", false],
		["https://app.example.com/assets/index-Bx81.js", "assets/other.js", false],
		["file:///srv/app/dist/main.js", "dist/main.js", true],
		["app:///dist/main.js", "dist/main.js", true],
		["/srv/app/dist/main.js", "dist/main.js", true],
		["https://app.example.com/assets/index.js", "", false],
	])("%s against %s is %s", (url, path, expected) => {
		expect(urlMatchesMinifiedPath(url, path)).toBe(expected)
	})
})

describe("isInAppPath", () => {
	it.each([
		["src/components/Button.tsx", true],
		["https://app.example.com/assets/index.js", true],
		["../node_modules/react-dom/cjs/react-dom.development.js", false],
		["webpack/runtime/jsonp chunk loading", false],
		["webpack/bootstrap", false],
		["chrome-extension://abc/content.js", false],
		["moz-extension://abc/content.js", false],
		["safari-extension://abc/content.js", false],
		["node:internal/process/task_queues", false],
		["<anonymous>", false],
		["native", false],
	])("%s is %s", (path, expected) => {
		expect(isInAppPath(path)).toBe(expected)
	})
})

describe("SymbolicatedStack schema", () => {
	it("round-trips the wire shape", () => {
		const wire = {
			status: "partial",
			frames: [
				{
					raw: "at a (https://x/a.js:1:1)",
					function: "a",
					file: "src/a.ts",
					line: 3,
					column: 1,
					in_app: true,
					resolved: true,
					context: { pre: ["x"], line: "y", post: [] },
				},
			],
			missing: ["https://x/b.js"],
		}
		expect(
			Schema.encodeSync(SymbolicatedStack)(Schema.decodeUnknownSync(SymbolicatedStack)(wire)),
		).toEqual(wire)
		expect(() => Schema.decodeUnknownSync(SymbolicatedStack)({ ...wire, status: "done" })).toThrow()
	})
})
