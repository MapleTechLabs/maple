// `error.cause` chains and `AggregateError.errors`, rendered into the stack
// trace as `Caused by:` blocks after the error's own frames, the way OTel Java
// records a Throwable. Fingerprints hash the top frames, so they stay put.
import type { Exception } from "@opentelemetry/api"

/** Deep enough for real wrapping chains, bounded against a cause cycle or a huge aggregate. */
const MAX_LINKED = 5

function linkedErrors(error: Error): unknown[] {
	const linked: unknown[] = []
	const seen = new Set<unknown>([error])
	const queue: unknown[] = [error]
	while (queue.length > 0 && linked.length < MAX_LINKED) {
		const current = queue.shift()
		const next: unknown[] = []
		if (current instanceof AggregateError) next.push(...current.errors)
		if (current instanceof Error && current.cause !== undefined) next.push(current.cause)
		for (const candidate of next) {
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
	const stack = error.stack ?? ""
	const header = error.message ? `${error.name}: ${error.message}` : error.name
	return stack.startsWith(header) ? stack.slice(header.length).replace(/^\n/, "") : stack
}

function describe(value: unknown): string {
	if (!(value instanceof Error)) return `Caused by: ${String(value)}`
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

/**
 * What to hand `span.recordException`: the error itself when nothing is linked,
 * otherwise a copy carrying the longer stack. `code` is kept because OTel
 * prefers it over `name` for `exception.type`.
 */
export function exceptionOf(error: Error): Exception {
	const stack = stackWithCauses(error)
	if (stack === error.stack) return error
	const code = "code" in error ? error.code : undefined
	const base = { name: error.name, message: error.message, stack }
	return typeof code === "string" || typeof code === "number" ? { ...base, code } : base
}
