// Command args become span attributes verbatim in Foldkit's runtime, and apps
// put message text, invite tokens and API keys in them. Default-deny: only ids
// and flags survive unless the app allows a key by name.

/** How Command args reach span attributes. */
export type CommandArgsPolicy =
	| "ids"
	| "all"
	| "none"
	| {
			/** Arg keys exported as-is, on top of ids and flags. */
			readonly allow?: ReadonlyArray<string> | undefined
	  }

export const REDACTED = "[redacted]"
const MAX_STRING = 256
const MAX_ARRAY = 20
const ID_KEY = /(?:^id|Id|Ids|_id|_ids)$/

type Primitive = string | number | boolean

const capString = (value: string): string =>
	value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value

/** Primitives and arrays of primitives, size-capped. Anything else is not an attribute. */
const toAttributeValue = (value: unknown): Primitive | ReadonlyArray<Primitive> | null | undefined => {
	if (value === null) return null
	if (typeof value === "string") return capString(value)
	if (typeof value === "number" || typeof value === "boolean") return value
	if (Array.isArray(value)) {
		const items: Array<Primitive> = []
		for (const item of value.slice(0, MAX_ARRAY)) {
			if (typeof item === "string") items.push(capString(item))
			else if (typeof item === "number" || typeof item === "boolean") items.push(item)
			else return undefined
		}
		return items
	}
	return undefined
}

export const makeArgsScrubber = (
	policy: CommandArgsPolicy = "ids",
): ((args: Readonly<Record<string, unknown>> | undefined) => Record<string, unknown>) => {
	if (policy === "none") return () => ({})
	const allow = new Set(typeof policy === "object" ? (policy.allow ?? []) : [])
	const keepsAll = policy === "all"
	return (args) => {
		const out: Record<string, unknown> = {}
		if (args === undefined) return out
		for (const key of Object.keys(args)) {
			const value = toAttributeValue(args[key])
			if (value === undefined) continue
			const kept =
				keepsAll || allow.has(key) || typeof value === "boolean" || value === null || ID_KEY.test(key)
			out[key] = kept ? value : REDACTED
		}
		return out
	}
}
