import { forgetPatchesForTests, patchMethod } from "../../capture/patch"
import { type Emit, safeEmit } from "../../capture/shared"
import { isJsonObject } from "../../platform/json"
import { truncateText } from "../../platform/text"

const LEVELS = ["log", "info", "warn", "error", "debug"] as const
type Level = (typeof LEVELS)[number]

const MAX_MESSAGE = 2_000
/** No array logged into a 2,000-character message needs more elements than this. */
const MAX_ARRAY_ELEMENTS = 100
/** Nor more keys of one object, or more levels of nesting. */
const MAX_OBJECT_KEYS = 50
const MAX_DEPTH = 6

type ConsoleListener = (level: Level, args: ReadonlyArray<unknown>) => void

/**
 * Everyone capturing this module's console wrappers: breadcrumbs and replay can
 * both listen. One wrapper per level per page, toggled by whether anyone
 * listens, so starting and stopping capture across visibility changes does not
 * stack wrappers.
 */
const listeners = new Set<ConsoleListener>()
let unpatch: Array<() => void> = []
/** Set while listeners run: a listener that logs must not be captured again. */
let dispatching = false

function wrapLevel(level: Level) {
	return (original: Console[Level], hooks: () => Set<ConsoleListener> | undefined): Console[Level] =>
		(...args: unknown[]): void => {
			const subscribers = hooks()
			if (subscribers && !dispatching) {
				dispatching = true
				try {
					for (const listener of subscribers) listener(level, args)
				} catch {
					// Capture must never break the host app's logging.
				} finally {
					dispatching = false
				}
			}
			original.apply(console, args)
		}
}

export interface ConsoleCaptureOptions {
	/** Keep level and count only: a console line can carry anything the page shows. */
	readonly maskText?: boolean | undefined
}

/**
 * Capture `console.*` calls as session events, then forward to the original so
 * the host app's console behaves normally. Never throws into the call site.
 * Teardown leaves a wrapper that something else wrapped in place, inert.
 */
export function installConsoleCapture(emit: Emit, options: ConsoleCaptureOptions = {}): () => void {
	const listener: ConsoleListener = (level, args) => {
		safeEmit(emit, {
			type: "console",
			level,
			...(options.maskText ? undefined : { message: formatArgs(args) }),
		})
	}
	if (listeners.size === 0) {
		unpatch = LEVELS.map((level) => patchMethod(console, level, listeners, wrapLevel(level)))
	}
	listeners.add(listener)
	let removed = false
	return () => {
		if (removed) return
		removed = true
		listeners.delete(listener)
		if (listeners.size > 0) return
		for (const off of unpatch) off()
		unpatch = []
	}
}

/** One console line as text, at most `MAX_MESSAGE` characters. Never throws. */
export function formatArgs(args: ReadonlyArray<unknown>): string {
	let text = ""
	for (const arg of args) {
		if (text.length > MAX_MESSAGE) break
		const room = MAX_MESSAGE - text.length + 1
		text += (text ? " " : "") + formatArg(arg, room)
	}
	return truncateText(text, MAX_MESSAGE, "…")
}

function formatArg(arg: unknown, budget: number): string {
	if (typeof arg === "string") return truncateText(arg, budget)
	try {
		if (arg instanceof Error) return truncateText(`${arg.name}: ${arg.message}`, budget)
		return boundedStringify(arg, budget)
	} catch {
		return "[Unserializable]"
	}
}

/**
 * JSON-like text of `value`, stopping once roughly `budget` characters are
 * written. Reads own data properties only, never getters or `toJSON`, and caps
 * keys, elements and depth, so logging a store object costs bounded time and
 * runs none of the page's code. A hostile object (a throwing Proxy) ends the
 * walk with what was written so far.
 */
export function boundedStringify(value: unknown, budget: number): string {
	let out = ""
	const ancestors: object[] = []
	const full = (): boolean => out.length > budget
	const room = (): number => Math.max(0, budget - out.length) + 2
	/** A quoted string cut to the room left: escaping can grow it sixfold. */
	const quote = (text: string): string => truncateText(JSON.stringify(truncateText(text, room())), room())

	const visit = (node: unknown, depth: number): void => {
		if (full()) return
		switch (typeof node) {
			case "string":
				out += quote(node)
				return
			case "number":
			case "boolean":
			case "bigint":
			case "symbol":
			case "undefined":
				out += truncateText(String(node), room())
				return
			case "function":
				out += "[Function]"
				return
		}
		if (typeof node !== "object" || node === null) {
			out += "null"
			return
		}
		if (ancestors.includes(node)) {
			out += '"[Circular]"'
			return
		}
		if (node instanceof Date) {
			out += Number.isNaN(node.getTime()) ? "null" : JSON.stringify(node.toISOString())
			return
		}
		if (depth >= MAX_DEPTH) {
			out += Array.isArray(node) ? "[…]" : "{…}"
			return
		}
		ancestors.push(node)
		try {
			if (Array.isArray(node)) visitArray(node, depth)
			else if (isJsonObject(node)) visitObject(node, depth)
		} catch {
			// A throwing Proxy trap: this value keeps what was written, its siblings still print.
		} finally {
			ancestors.pop()
		}
	}

	const visitArray = (node: ReadonlyArray<unknown>, depth: number): void => {
		out += "["
		try {
			const count = Math.min(node.length, MAX_ARRAY_ELEMENTS)
			for (let index = 0; index < count && !full(); index++) {
				if (index > 0) out += ","
				visitProperty(node, String(index), depth + 1)
			}
			if (node.length > count && !full()) out += ",…"
		} finally {
			out += "]"
		}
	}

	/** An own property's value, without running a getter: one could have side effects. */
	const visitProperty = (
		node: Readonly<Record<string, unknown>> | ReadonlyArray<unknown>,
		key: string,
		depth: number,
	): void => {
		const descriptor = Object.getOwnPropertyDescriptor(node, key)
		if (!descriptor) out += "undefined"
		else visit("value" in descriptor ? descriptor.value : "[Getter]", depth)
	}

	const visitObject = (node: Readonly<Record<string, unknown>>, depth: number): void => {
		out += "{"
		try {
			let written = 0
			for (const key in node) {
				if (full()) break
				if (!Object.prototype.hasOwnProperty.call(node, key)) continue
				if (written === MAX_OBJECT_KEYS) {
					out += ",…"
					break
				}
				out += `${written > 0 ? "," : ""}${quote(key)}:`
				visitProperty(node, key, depth + 1)
				written++
			}
		} finally {
			out += "}"
		}
	}

	try {
		visit(value, 0)
	} catch {
		// `instanceof` or `typeof` on a revoked Proxy: keep what was written before it.
	}
	return out
}

/** Test seam: forget every listener and restore the console methods still ours. */
export function resetConsoleCaptureForTests(): void {
	listeners.clear()
	for (const off of unpatch) off()
	unpatch = []
	forgetPatchesForTests(console)
}
