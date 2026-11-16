import { codeUnitAt } from "@maple/strings"
import { Array as Arr, Option, Order, Schema, String as Str } from "effect"

// A profile as a tree: the stacks a window holds, folded frame by frame from the root, plus the
// icicle geometry and the per-function totals read off it.

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

export interface ProfileNode {
	/** Stable for a given path, so a zoom survives a refetch. */
	readonly id: string
	readonly name: string
	readonly file: string
	readonly line: number
	readonly depth: number
	/** Value of this frame and everything it called. */
	readonly total: number
	/** Value sampled in this frame itself. */
	readonly self: number
	readonly children: ReadonlyArray<ProfileNode>
}

/** Which frames a flame graph draws: every one, or only the service's own code. */
export const FrameScope = Schema.Literals(["all", "app"])
export type FrameScope = typeof FrameScope.Type

/** What a stack with none of the service's own frames on it folds into. */
export const OUTSIDE_NAME = "(libraries and runtime)"

export const ROOT_ID = "root"
/** The stacks a capped read left out, as one frame under the root. */
export const OTHER_NAME = "(other stacks)"

interface Building {
	readonly id: string
	readonly name: string
	readonly file: string
	readonly line: number
	readonly depth: number
	total: number
	self: number
	readonly children: Map<string, Building>
}

const lastSix = Str.slice(-6)

// FNV-1a over the parent id and the frame, so an id names a path without carrying it.
const pathId = (parentId: string, key: string): string => {
	let hash = 0x811c9dc5
	const text = `${parentId}\u0000${key}`
	for (let index = 0; index < text.length; index++) {
		hash ^= codeUnitAt(text, index)
		hash = Math.imul(hash, 0x01000193)
	}
	return `${lastSix(parentId)}${(hash >>> 0).toString(36)}`
}

const byWeight = Order.mapInput(Order.flip(Order.Number), (node: ProfileNode) => node.total)
const byName = Order.mapInput(Order.String, (node: ProfileNode) => node.name)

const freeze = (node: Building): ProfileNode => ({
	id: node.id,
	name: node.name,
	file: node.file,
	line: node.line,
	depth: node.depth,
	total: node.total,
	self: node.self,
	// Heaviest first, so the widest path reads down the left edge.
	children: Arr.sort(Arr.map([...node.children.values()], freeze), Order.combine(byWeight, byName)),
})

// Keyed on the stacks array: a view rebuilds its input object every render, the rows it holds
// change only when a fetch lands.
const trees = new WeakMap<
	ReadonlyArray<ProfileStack>,
	{ readonly totalValue: number; readonly tree: ProfileNode }
>()

/** A function's identity: same-named closures in one file are told apart by the line they start on. */
const frameKey = (name: string, file: string, line: number): string => `${name}\u0000${file}\u0000${line}`

/** The stacks folded into one tree under a synthetic root that holds the whole window. */
export const profileTree = (input: ProfileInput): ProfileNode => {
	const cached = trees.get(input.stacks)
	if (cached !== undefined && cached.totalValue === input.totalValue) return cached.tree
	const root: Building = {
		id: ROOT_ID,
		name: "all",
		file: "",
		line: 0,
		depth: 0,
		total: 0,
		self: 0,
		children: new Map(),
	}
	Arr.forEach(input.stacks, (stack) => {
		if (stack.value <= 0) return
		root.total += stack.value
		let node = root
		Arr.forEach(stack.frames, (name, index) => {
			const file = stack.files[index] ?? ""
			const line = stack.lines[index] ?? 0
			const key = frameKey(name, file, line)
			let child = node.children.get(key)
			if (child === undefined) {
				child = {
					id: pathId(node.id, key),
					name,
					file,
					line,
					depth: node.depth + 1,
					total: 0,
					self: 0,
					children: new Map(),
				}
				node.children.set(key, child)
			}
			child.total += stack.value
			node = child
		})
		node.self += stack.value
	})
	const other = input.totalValue - root.total
	if (other > 0) {
		root.children.set(OTHER_NAME, {
			id: pathId(ROOT_ID, frameKey(OTHER_NAME, "", 0)),
			name: OTHER_NAME,
			file: "",
			line: 0,
			depth: 1,
			total: other,
			self: other,
			children: new Map(),
		})
		root.total += other
	}
	const tree = freeze(root)
	trees.set(input.stacks, { totalValue: input.totalValue, tree })
	return tree
}

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

/** Whether a frame matches a search: its name or its file, ignoring case. */
export const matchesSearch = (node: Pick<ProfileNode, "id" | "name" | "file">, query: string): boolean => {
	const needle = Str.toLowerCase(Str.trim(query))
	// The synthetic root is the whole window, not a frame: "a" or "al" never match it.
	if (needle === "" || node.id === ROOT_ID) return false
	const holdsNeedle = Str.includes(needle)
	return holdsNeedle(Str.toLowerCase(node.name)) || holdsNeedle(Str.toLowerCase(node.file))
}

/** The value under frames matching `query`, counting a matching frame's subtree once. */
export const matchedValue = (root: ProfileNode, query: string): number => {
	const walk = (node: ProfileNode): number =>
		matchesSearch(node, query)
			? node.total
			: Arr.reduce(node.children, 0, (sum, child) => sum + walk(child))
	return walk(root)
}

// Built once: `frameModule` runs for every frame of every stack.
const MODULES_MARKER = "node_modules/"
const lastModulesMarker = Str.lastIndexOf(MODULES_MARKER)
const notFound = (): number => -1
const isScopedPackage = Str.startsWith("@")
const isNodeBuiltin = Str.startsWith("node:")
const isBunBuiltin = Str.startsWith("bun:")
const isNodeInternal = Str.startsWith("internal/")

/**
 * Where a frame's code lives, for colouring and grouping: the package under `node_modules`, a
 * runtime built-in (`node:`), or the app's own code.
 */
export const frameModule = (file: string): string => {
	if (file === "") return "(native)"
	const at = Option.getOrElse(lastModulesMarker(file), notFound)
	if (at !== -1) {
		const parts = Str.split(Str.slice(at + MODULES_MARKER.length)(file), "/")
		const first = parts[0]
		return isScopedPackage(first) ? `${first}/${parts[1] ?? ""}` : first
	}
	if (isNodeBuiltin(file) || isBunBuiltin(file) || isNodeInternal(file)) return "(runtime)"
	return "app"
}

const scoped = new WeakMap<ReadonlyArray<ProfileStack>, ProfileInput>()

/**
 * The stacks as `scope` draws them. `app` keeps only frames from the service's own files, so
 * time in a library or the runtime counts as the own function that called it, and stacks that
 * never enter own code fold into one frame. The total is unchanged.
 */
export const scopedStacks = (input: ProfileInput, scope: FrameScope): ProfileInput => {
	if (scope === "all") return input
	const cached = scoped.get(input.stacks)
	if (cached !== undefined && cached.totalValue === input.totalValue) return cached
	const merged = new Map<
		string,
		{ frames: Array<string>; files: Array<string>; lines: Array<number>; value: number }
	>()
	Arr.forEach(input.stacks, (stack) => {
		const kept = Arr.filter(
			Arr.map(stack.frames, (name, index) => ({
				name,
				file: stack.files[index] ?? "",
				line: stack.lines[index] ?? 0,
			})),
			(frame) => frameModule(frame.file) === "app",
		)
		const frames = kept.length === 0 ? [{ name: OUTSIDE_NAME, file: "", line: 0 }] : kept
		const key = Arr.join(
			Arr.map(frames, (frame) => frameKey(frame.name, frame.file, frame.line)),
			"\u0001",
		)
		const row = merged.get(key)
		if (row === undefined)
			merged.set(key, {
				frames: Arr.map(frames, (frame) => frame.name),
				files: Arr.map(frames, (frame) => frame.file),
				lines: Arr.map(frames, (frame) => frame.line),
				value: stack.value,
			})
		else row.value += stack.value
	})
	const result: ProfileInput = { stacks: [...merged.values()], totalValue: input.totalValue }
	scoped.set(input.stacks, result)
	return result
}
