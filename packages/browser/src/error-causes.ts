import { stackWithCauses } from "@maple/sdk-core"
import type { Exception } from "@opentelemetry/api"

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
