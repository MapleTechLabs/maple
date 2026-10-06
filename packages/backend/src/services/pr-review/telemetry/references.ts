/**
 * Which alert rules and dashboards read a telemetry name.
 *
 * A rule or dashboard is reduced to every string it stores (query specs, builder drafts, where
 * clauses, raw SQL), and a name is referenced when one of them is the name or holds it as a whole
 * token. That reads every query shape the product stores without a decoder per version.
 */
import { PrReviewTelemetryReference } from "@maple/domain/http"

export interface ReferenceSource {
	readonly kind: "alert" | "dashboard"
	readonly id: string
	readonly name: string
	readonly texts: ReadonlyArray<string>
}

/** Every string leaf of a stored JSON value. */
export const textsOf = (value: unknown, out: Array<string> = []): Array<string> => {
	if (typeof value === "string") {
		if (value.length > 0) out.push(value)
	} else if (Array.isArray(value)) {
		for (const item of value) textsOf(item, out)
	} else if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) textsOf(item, out)
	}
	return out
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The name as a whole token: not inside a longer name (`http.route` is not in `http.route.raw`),
 * but found behind the `attr.` and `resource.` prefixes query drafts use.
 */
const tokenPattern = (name: string) =>
	new RegExp(
		`(?:^|[^A-Za-z0-9_.]|(?:attr|resource)\\.)${escapeRegExp(name)}(?![A-Za-z0-9_]|\\.[A-Za-z0-9_])`,
	)

export const referencesFor = (
	name: string,
	sources: ReadonlyArray<ReferenceSource>,
): ReadonlyArray<PrReviewTelemetryReference> => {
	const pattern = tokenPattern(name)
	return sources
		.filter((source) => source.texts.some((text) => text === name || pattern.test(text)))
		.map((source) => new PrReviewTelemetryReference({ kind: source.kind, id: source.id, name: source.name }))
}
