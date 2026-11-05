// A thrown value as an `exception` event records it: one `Error`, with its cause
// chain and `errors` list appended as `Caused by:` blocks after its own frames,
// which is why fingerprints (hashed on the top frames) do not move.

/** Deep enough for real wrapping chains, bounded against a cause cycle or a huge aggregate. */
const MAX_LINKED = 5
/** A thrown plain object is summarised by its first few primitive fields, never walked. */
const MAX_SUMMARY_FIELDS = 8
const MAX_SUMMARY_VALUE = 80
const MAX_SUMMARY = 300

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

/** The fields an error is read by; an `Error` and any plain object both fit. */
interface ErrorFields {
	readonly name?: unknown
	readonly message?: unknown
	readonly stack?: unknown
	readonly cause?: unknown
	readonly errors?: unknown
}

/** A property read that a throwing getter or Proxy trap cannot turn into a second error. */
function read(value: ErrorFields, key: keyof ErrorFields): unknown {
	try {
		return value[key]
	} catch {
		return undefined
	}
}

function isErrorInstance(value: unknown): value is Error {
	try {
		return value instanceof Error
	} catch {
		return false
	}
}

/** Error-shaped: an `Error`, or a copy with its fields (Effect's pretty errors, a structured clone). */
function isErrorLike(value: unknown): value is Error {
	if (isErrorInstance(value)) return true
	if (!isRecord(value)) return false
	const stack = read(value, "stack")
	return (
		typeof read(value, "name") === "string" &&
		typeof read(value, "message") === "string" &&
		(stack === undefined || typeof stack === "string")
	)
}

/** Cut at a code point boundary, so a clipped value never ends in half a surrogate pair. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text
	const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max
	return `${text.slice(0, end)}…`
}

function tagOf(value: unknown): string {
	try {
		return Object.prototype.toString.call(value)
	} catch {
		return "[object Object]"
	}
}

/** `{"code":1,"reason":"busy"}`: what a thrown plain object says about itself, bounded. */
function summarize(value: Record<string, unknown>): string {
	let keys: string[]
	try {
		keys = Object.keys(value)
	} catch {
		return tagOf(value)
	}
	const fields: string[] = []
	for (const key of keys) {
		if (fields.length >= MAX_SUMMARY_FIELDS) break
		let field: unknown
		try {
			field = value[key]
		} catch {
			continue
		}
		const rendered =
			typeof field === "string"
				? JSON.stringify(clip(field, MAX_SUMMARY_VALUE))
				: typeof field === "number" || typeof field === "boolean" || field === null
					? String(field)
					: typeof field === "bigint"
						? `${field}n`
						: undefined
		if (rendered !== undefined) fields.push(`${JSON.stringify(clip(key, MAX_SUMMARY_VALUE))}:${rendered}`)
	}
	return fields.length > 0 ? clip(`{${fields.join(",")}}`, MAX_SUMMARY) : tagOf(value)
}

/**
 * An `Error` made here for a value thrown elsewhere. Its own stack would point
 * into the SDK, which is not where anything was thrown, and would group every
 * such throw into one issue, so it carries the source's stack or none.
 */
function madeError(message: string, name?: string, stack?: string): Error {
	const error = new Error(message)
	if (name !== undefined && name !== "") error.name = name
	try {
		Object.defineProperty(error, "stack", { value: stack, writable: true, configurable: true })
	} catch {}
	return error
}

function stringOf(value: unknown): string {
	try {
		return String(value)
	} catch {
		return "Unknown error"
	}
}

/**
 * BOUNDARY: a thrown value is unparsed by definition, JavaScript can throw anything.
 * Narrow it into an `Error` without ever throwing from the error path.
 */
export function asError(value: unknown): Error {
	if (isErrorInstance(value)) {
		const name = read(value, "name")
		const message = read(value, "message")
		const stack = read(value, "stack")
		if (
			typeof name === "string" &&
			typeof message === "string" &&
			(stack === undefined || typeof stack === "string")
		) {
			return value
		}
		// A Proxy or a mangled Error: a copy whose fields can be read safely.
		return madeError(
			typeof message === "string" ? message : "",
			typeof name === "string" ? name : undefined,
			typeof stack === "string" ? stack : undefined,
		)
	}
	if (typeof value === "string") return madeError(value)
	if (isRecord(value)) {
		const message = read(value, "message")
		if (typeof message === "string") {
			const name = read(value, "name")
			const stack = read(value, "stack")
			return madeError(
				message,
				typeof name === "string" ? name : undefined,
				typeof stack === "string" ? stack : undefined,
			)
		}
		return madeError(summarize(value))
	}
	return madeError(stringOf(value))
}

/** What an error links to: its `cause`, and its `errors` list (duck-typed, so copies qualify). */
const linksOf = (value: unknown): unknown[] => {
	if (!isRecord(value) || !isErrorLike(value)) return []
	const next: unknown[] = []
	// Arbitrary objects can carry throwing getters and Proxy traps; the error path must survive them.
	try {
		const errors = read(value, "errors")
		if (Array.isArray(errors)) next.push(...errors.slice(0, MAX_LINKED))
	} catch {}
	const cause = read(value, "cause")
	if (cause !== undefined) next.push(cause)
	return next
}

/** A null-prototype object or a throwing `toString` must not break the error path. */
function render(value: unknown): string {
	if (!isRecord(value)) return stringOf(value)
	const message = read(value, "message")
	return typeof message === "string" ? message : summarize(value)
}

function linkedErrors(error: Error): unknown[] {
	const linked: unknown[] = []
	const seen = new Set<unknown>([error])
	const queue: unknown[] = [error]
	while (queue.length > 0 && linked.length < MAX_LINKED) {
		for (const candidate of linksOf(queue.shift())) {
			if (seen.has(candidate) || linked.length >= MAX_LINKED) continue
			seen.add(candidate)
			linked.push(candidate)
			queue.push(candidate)
		}
	}
	return linked
}

function stringField(value: ErrorFields, key: keyof ErrorFields): string {
	const field = read(value, key)
	return typeof field === "string" ? field : ""
}

/** V8 starts a stack with a `Name: message` header; the other engines start at the first frame. */
function framesOf(error: Error): string {
	const stack = stringField(error, "stack")
	const name = stringField(error, "name")
	const message = stringField(error, "message")
	const header = message ? `${name}: ${message}` : name
	return stack.startsWith(header) ? stack.slice(header.length).replace(/^\n/, "") : stack
}

function describe(value: unknown): string {
	if (!isRecord(value) || !isErrorLike(value)) return `Caused by: ${render(value)}`
	const frames = framesOf(value)
	const header = `Caused by: ${stringField(value, "name")}: ${stringField(value, "message")}`
	return frames ? `${header}\n${frames}` : header
}

/** The stack trace to record for `error`, with its linked errors appended. */
export function stackWithCauses(error: Error): string | undefined {
	const own = read(error, "stack")
	const stack = typeof own === "string" ? own : undefined
	const linked = linkedErrors(error)
	if (linked.length === 0) return stack
	const head = stack ?? `${stringField(error, "name")}: ${stringField(error, "message")}`
	return [head, ...linked.map(describe)].join("\n")
}
