import { String as Str } from "effect"
/**
 * What the logs search box does with what you typed.
 *
 * A trace id (bare, or lifted out of a W3C `traceparent` header) becomes the
 * page's trace scope — an indexed `TraceId` seek, and a removable chip. Anything
 * else is a substring scan over message bodies, where a 32-hex id could never
 * have matched. The shape of the input picks the lookup, and the help sheet
 * beside the box lists the shapes it knows.
 */
export type LogSearchQuery =
	| { readonly kind: "trace"; readonly traceId: string }
	| { readonly kind: "text"; readonly text: string }

const TRACE_ID = /^[0-9a-f]{32}$/i
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i

export function parseLogSearch(raw: string | undefined): LogSearchQuery | undefined {
	const value = raw?.trim()
	if (!value) return undefined

	// Quotes are the escape hatch: they force a text search for something that
	// would otherwise read as an id (a trace id printed inside a message).
	if (value.length >= 2 && Str.startsWith('"')(value) && Str.endsWith('"')(value)) {
		const quoted = Str.slice(1, -1)(value)
		return quoted === "" ? undefined : { kind: "text", text: quoted }
	}

	if (TRACE_ID.test(value)) return { kind: "trace", traceId: Str.toLowerCase(value) }
	const fromHeader = TRACEPARENT.exec(value)?.[1]
	if (fromHeader) return { kind: "trace", traceId: Str.toLowerCase(fromHeader) }

	return { kind: "text", text: value }
}
