/**
 * Minimal structural guards for records read back out of browser storage.
 *
 * These replace what was an `effect/Schema` decoder. This package is *bundled*
 * into `@maple-dev/browser`, whose eager chunk every visitor downloads before
 * any sampling decision runs — and pulling Schema in to validate two flat
 * records cost ~30 kB gzipped, most of that SDK's entire page-load budget, for
 * shapes the callers already declare in TypeScript. Schema earns its size where
 * the input is genuinely unknown and the errors need to be legible; here the
 * only question is "did we write this, and is it still the shape we write",
 * and the only answer anyone acts on is yes/no.
 *
 * The semantics deliberately match what the Schema decoders did, because the
 * records in the wild were written by them:
 *
 * - unknown keys are dropped rather than rejected (callers rebuild an explicit
 *   object from the keys they know),
 * - a required key that is absent or wrongly typed rejects the whole record,
 * - an optional key must be either absent or correctly typed — `null` is not
 *   an accepted stand-in for absent, matching `Schema.optionalKey`.
 */

/** A non-null, non-array object — the only JSON shape these records take. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parse a storage string into a plain object, or `undefined` if it is not
 * valid JSON or not an object. Never throws: every caller here treats a
 * corrupt record as a cache miss, not as an error worth surfacing.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(raw)
		return isJsonObject(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

/** A `Record<string, string>` — every value a string, as `Schema.Record` required. */
export function isStringRecord(value: unknown): value is Record<string, string> {
	return isJsonObject(value) && Object.values(value).every((entry) => typeof entry === "string")
}

/** A `\\` pair, or the escape `JSON.stringify` writes for a lone surrogate. */
const LONE_SURROGATE_ESCAPE = /\\(?:\\|u[dD][89a-fA-F][0-9a-fA-F]{2})/g

/**
 * `JSON.stringify`, with every lone surrogate written as U+FFFD. JavaScript
 * strings may hold half an emoji; strict JSON parsers (ingest's among them)
 * reject the escape for one, and with it the whole NDJSON batch it rides in.
 * Paired surrogates are written as raw characters, so any `\uD8xx` escape left
 * in the output is a lone one.
 */
export function stringifyWellFormed(value: unknown): string {
	const json = JSON.stringify(value) ?? "null"
	return json.replace(LONE_SURROGATE_ESCAPE, (escape) => (escape === "\\\\" ? escape : "\\ufffd"))
}
