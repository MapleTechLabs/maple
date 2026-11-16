import { describe, expect, it } from "vitest"
import { Array as Arr, Option } from "effect"
import {
	frameModule,
	matchedValue,
	matchesSearch,
	OTHER_NAME,
	OUTSIDE_NAME,
	type ProfileInput,
	type ProfileNode,
	profileTree,
	scopedStacks,
	topFunctions,
} from "./profile-tree"

const stack = (frames: ReadonlyArray<string>, value: number) => ({
	frames,
	files: Arr.map(frames, () => "/app/server.js"),
	// A function starts on one line, wherever it is on the stack.
	lines: Arr.map(frames, (name) => name.length),
	value,
})

/** Two `(anonymous)` callbacks in one file, reached from different callers. */
const closures: ProfileInput = {
	stacks: [
		{
			frames: ["parse", "(anonymous)"],
			files: ["/app/server.js", "/app/server.js"],
			lines: [5, 20],
			value: 30,
		},
		{
			frames: ["render", "(anonymous)"],
			files: ["/app/server.js", "/app/server.js"],
			lines: [6, 80],
			value: 70,
		},
	],
	totalValue: 100,
}

const input: ProfileInput = {
	stacks: [
		stack(["main", "handle", "parse"], 60),
		stack(["main", "handle", "render"], 30),
		stack(["main", "handle"], 5),
		stack(["main", "gc"], 5),
	],
	totalValue: 100,
}

const child = (node: ProfileNode | undefined, name: string): ProfileNode | undefined =>
	Option.getOrUndefined(Arr.findFirst(node?.children ?? [], (each) => each.name === name))

describe("profileTree", () => {
	it("folds stacks into callers and callees with self and total values", () => {
		const root = profileTree(input)
		const handle = child(child(root, "main"), "handle")
		expect([root.total, handle?.total, handle?.self]).toEqual([100, 95, 5])
		expect(Arr.map(handle?.children ?? [], (each) => [each.name, each.total, each.self])).toEqual([
			["parse", 60, 60],
			["render", 30, 30],
		])
	})

	it("draws the stacks a capped read left out as one frame", () => {
		const root = profileTree({ stacks: [stack(["main"], 40)], totalValue: 100 })
		expect(Arr.map(root.children, (each) => [each.name, each.total])).toEqual([
			[OTHER_NAME, 60],
			["main", 40],
		])
	})

	it("gives the same path the same id across reads", () => {
		const again = profileTree({ ...input, stacks: [...input.stacks].reverse() })
		expect(child(child(again, "main"), "handle")?.id).toBe(
			child(child(profileTree(input), "main"), "handle")?.id,
		)
	})
})

describe("topFunctions", () => {
	it("ranks functions by their own value and counts a recursive function's stack once", () => {
		const rows = topFunctions(
			{
				stacks: [stack(["main", "walk", "walk", "walk"], 10), stack(["main", "walk", "leaf"], 4)],
				totalValue: 14,
			},
			10,
		)
		expect(Arr.map(rows, (row) => [row.name, row.self, row.total])).toEqual([
			["walk", 10, 14],
			["leaf", 4, 4],
			["main", 0, 14],
		])
	})
})

describe("same-named functions in one file", () => {
	it("stay two functions in the top functions, each with its own line", () => {
		const rows = Arr.filter(topFunctions(closures, 10), (row) => row.name === "(anonymous)")
		expect(Arr.map(rows, (row) => [row.line, row.self])).toEqual([
			[80, 70],
			[20, 30],
		])
	})

	it("stay two frames when they share a caller", () => {
		const root = profileTree({
			stacks: [
				{
					frames: ["main", "(anonymous)"],
					files: ["/app/a.js", "/app/a.js"],
					lines: [1, 20],
					value: 30,
				},
				{
					frames: ["main", "(anonymous)"],
					files: ["/app/a.js", "/app/a.js"],
					lines: [1, 80],
					value: 70,
				},
			],
			totalValue: 100,
		})
		const main = child(root, "main")
		expect(Arr.map(main?.children ?? [], (each) => [each.line, each.total])).toEqual([
			[80, 70],
			[20, 30],
		])
		expect(new Set(Arr.map(main?.children ?? [], (each) => each.id)).size).toBe(2)
	})

	it("stay two stacks when own code is folded", () => {
		const scoped = scopedStacks(
			{
				stacks: [
					{
						frames: ["(anonymous)", "lib"],
						files: ["/app/a.js", "/node_modules/x/i.js"],
						lines: [20, 1],
						value: 30,
					},
					{
						frames: ["(anonymous)", "lib"],
						files: ["/app/a.js", "/node_modules/x/i.js"],
						lines: [80, 1],
						value: 70,
					},
				],
				totalValue: 100,
			},
			"app",
		)
		expect(Arr.map(scoped.stacks, (each) => [each.lines, each.value])).toEqual([
			[[20], 30],
			[[80], 70],
		])
	})
})

describe("matchedValue", () => {
	it("sums the subtrees of matching frames without counting a nested match twice", () => {
		expect(matchedValue(profileTree(input), "HANDLE")).toBe(95)
		expect(matchedValue(profileTree(input), "")).toBe(0)
	})

	it("never matches the synthetic root, whose name is a part of short queries", () => {
		// "al" is in the root's name "all" and in no frame: nothing matches.
		expect(matchedValue(profileTree(input), "al")).toBe(0)
		expect(matchesSearch(profileTree(input), "al")).toBe(false)
	})
})

describe("frameModule", () => {
	it.each([
		["/app/node_modules/effect/dist/Fiber.js", "effect"],
		["/app/node_modules/.bun/x/node_modules/@effect/platform/dist/a.js", "@effect/platform"],
		["node:internal/timers", "(runtime)"],
		["/app/src/server.ts", "app"],
		["", "(native)"],
	])("%s -> %s", (file, module) => {
		expect(frameModule(file)).toBe(module)
	})
})

describe("scopedStacks", () => {
	const mixed: ProfileInput = {
		stacks: [
			{
				frames: ["runLoop", "handle", "stringify"],
				files: ["/app/node_modules/effect/dist/internal/effect.js", "/app/src/server.ts", ""],
				lines: [464, 12, 0],
				value: 30,
			},
			{
				frames: ["runLoop", "handle", "parse"],
				files: [
					"/app/node_modules/effect/dist/internal/effect.js",
					"/app/src/server.ts",
					"/app/node_modules/qs/index.js",
				],
				lines: [464, 12, 40],
				value: 20,
			},
			{ frames: ["(program)"], files: [""], lines: [0], value: 50 },
		],
		totalValue: 100,
	}

	it("keeps only the service's own frames, so library time counts as the own caller's", () => {
		const own = scopedStacks(mixed, "app")
		expect(Arr.map(own.stacks, (each) => [each.frames, each.value])).toEqual([
			[["handle"], 50],
			[[OUTSIDE_NAME], 50],
		])
		expect(Arr.map(topFunctions(own, 5), (row) => [row.name, row.self])).toEqual([
			["handle", 50],
			[OUTSIDE_NAME, 50],
		])
	})

	it("leaves the total and the unscoped stacks as they were", () => {
		expect(scopedStacks(mixed, "app").totalValue).toBe(100)
		expect(scopedStacks(mixed, "all")).toBe(mixed)
	})
})
