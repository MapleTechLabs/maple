import { Array as Arr, Order } from "effect"

// Continuous profiling stacks and the per-function totals read off them, shared by the flame
// graph and the MCP `profile_hotspots` tool.

/** One distinct stack and its summed value; `frames` runs root first, the others are parallel. */
export interface ProfileStack {
	readonly frames: ReadonlyArray<string>
	readonly files: ReadonlyArray<string>
	readonly lines: ReadonlyArray<number>
	readonly value: number
}

export interface ProfileInput {
	readonly stacks: ReadonlyArray<ProfileStack>
	/** Every stack in scope, including those past the cap: the gap is drawn as one node. */
	readonly totalValue: number
}

/** A function's identity: same-named closures in one file are told apart by the line they start on. */
export const frameKey = (name: string, file: string, line: number): string =>
	`${name}\u0000${file}\u0000${line}`

export interface FunctionTotal {
	readonly name: string
	readonly file: string
	readonly line: number
	/** Value sampled in the function itself. */
	readonly self: number
	/** Value of every stack the function is on, each stack counted once. */
	readonly total: number
}

const bySelf = Order.mapInput(Order.flip(Order.Number), (row: FunctionTotal) => row.self)
const byTotal = Order.mapInput(Order.flip(Order.Number), (row: FunctionTotal) => row.total)

/** Functions by their own value, heaviest first: where the time (or the bytes) actually went. */
export const topFunctions = (input: ProfileInput, limit: number): ReadonlyArray<FunctionTotal> => {
	const totals = new Map<
		string,
		{ name: string; file: string; line: number; self: number; total: number }
	>()
	Arr.forEach(input.stacks, (stack) => {
		if (stack.value <= 0) return
		const seen = new Set<string>()
		const leaf = stack.frames.length - 1
		Arr.forEach(stack.frames, (name, index) => {
			const file = stack.files[index] ?? ""
			const line = stack.lines[index] ?? 0
			const key = frameKey(name, file, line)
			const row = totals.get(key) ?? { name, file, line, self: 0, total: 0 }
			totals.set(key, row)
			if (index === leaf) row.self += stack.value
			// Recursion puts a function on a stack more than once; its time is counted once.
			if (!seen.has(key)) {
				seen.add(key)
				row.total += stack.value
			}
		})
	})
	return Arr.take(Arr.sort([...totals.values()], Order.combine(bySelf, byTotal)), limit)
}
