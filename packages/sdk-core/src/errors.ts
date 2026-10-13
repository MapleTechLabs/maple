// A thrown value as an `exception` event records it: one `Error`, with its cause
// chain and `errors` list appended as `Caused by:` blocks after its own frames,
// which is why fingerprints (hashed on the top frames) do not move.

/** Deep enough for real wrapping chains, bounded against a cause cycle or a huge aggregate. */
const MAX_LINKED = 5

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

/** Error-shaped: an `Error`, or a copy with its fields (Effect's pretty errors, a structured clone). */
const isErrorLike = (value: unknown): value is Error =>
	value instanceof Error ||
	(isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.message === "string" &&
		(value.stack === undefined || typeof value.stack === "string"))

/**
 * BOUNDARY: a thrown value is unparsed by definition, JavaScript can throw anything.
 * Narrow it into an `Error` without ever throwing from the error path.
 */
export function asError(value: unknown): Error {
	if (value instanceof Error) return value
	if (typeof value === "string") return new Error(value)
	if (isRecord(value) && typeof value.message === "string") return new Error(value.message)
	try {
		return new Error(String(value))
	} catch {
		return new Error("Unknown error")
	}
}

/** What an error links to: its `cause`, and its `errors` list (duck-typed, so copies qualify). */
const linksOf = (value: unknown): unknown[] => {
	if (!isErrorLike(value)) return []
	const next: unknown[] = []
	// Arbitrary objects can carry throwing getters; the error path must survive them.
	try {
		if ("errors" in value && Array.isArray(value.errors)) next.push(...value.errors)
		if (value.cause !== undefined) next.push(value.cause)
	} catch {}
	return next
}

/** A null-prototype object or a throwing `toString` must not break the error path. */
function render(value: unknown): string {
	if (isRecord(value) && typeof value.message === "string") return value.message
	try {
		return String(value)
	} catch {
		return Object.prototype.toString.call(value)
	}
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

/** V8 starts a stack with a `Name: message` header; the other engines start at the first frame. */
function framesOf(error: Error): string {
	const stack = typeof error.stack === "string" ? error.stack : ""
	const header = error.message ? `${error.name}: ${error.message}` : error.name
	return stack.startsWith(header) ? stack.slice(header.length).replace(/^\n/, "") : stack
}

function describe(value: unknown): string {
	if (!isErrorLike(value)) return `Caused by: ${render(value)}`
	const frames = framesOf(value)
	const header = `Caused by: ${value.name}: ${value.message}`
	return frames ? `${header}\n${frames}` : header
}

/** The stack trace to record for `error`, with its linked errors appended. */
export function stackWithCauses(error: Error): string | undefined {
	const linked = linkedErrors(error)
	if (linked.length === 0) return error.stack
	return [error.stack ?? `${error.name}: ${error.message}`, ...linked.map(describe)].join("\n")
}
