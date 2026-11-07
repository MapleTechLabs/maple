import { Array as Arr, String as Str } from "effect"
/**
 * The `metric` and `group_by` tokens `query_data` accepts, per `source` × `kind`.
 *
 * These cannot be `Schema.Literals` on the MCP input struct, because the valid set
 * depends on two OTHER parameters (`source=logs` accepts only `count`,
 * `group_by=none` is timeseries-only). So the tool takes free-form
 * strings and the real narrowing happens downstream in `QuerySpec`.
 *
 * That left agents guessing: every `query_data` failure in production was a valid-
 * looking token rejected by a combination that does not accept it, reported as a
 * bare `SchemaError` that never named the alternatives. This table is what turns
 * those into an actionable message.
 *
 * `query-spec-tokens.test.ts` asserts every entry against the domain schemas by
 * decoding, so this table cannot drift from `@maple/domain/query-engine`.
 */

export type QuerySpecSource = "traces" | "logs" | "metrics" | "product_events"
export type QuerySpecKind = "timeseries" | "breakdown"

interface TokenSet {
	readonly metrics: ReadonlyArray<string>
	readonly groupBys: ReadonlyArray<string>
}

const TOKENS = {
	"traces:timeseries": {
		metrics: [
			"count",
			"avg_duration",
			"p50_duration",
			"p95_duration",
			"p99_duration",
			"error_rate",
			"apdex",
		],
		groupBys: ["service", "span_name", "status_code", "http_method", "attribute", "none"],
	},
	"traces:breakdown": {
		metrics: [
			"count",
			"avg_duration",
			"p50_duration",
			"p95_duration",
			"p99_duration",
			"error_rate",
			"apdex",
		],
		groupBys: ["service", "span_name", "status_code", "http_method", "attribute"],
	},
	"logs:timeseries": {
		metrics: ["count"],
		groupBys: ["service", "severity", "none"],
	},
	"logs:breakdown": {
		metrics: ["count"],
		groupBys: ["service", "severity", "attribute", "resource_attribute"],
	},
	"metrics:breakdown": {
		metrics: ["avg", "sum", "min", "max", "count", "latest", "rate", "increase"],
		groupBys: ["service", "attribute", "resource_attribute"],
	},
	"metrics:timeseries": {
		metrics: ["avg", "sum", "min", "max", "count", "latest", "rate", "increase"],
		groupBys: ["service", "attribute", "resource_attribute", "none"],
	},
	"product_events:timeseries": {
		metrics: ["count", "sessions", "persons", "users", "visitors"],
		groupBys: [
			"event_name",
			"kind",
			"source",
			"host",
			"page_path",
			"service",
			"group",
			"attribute",
			"none",
		],
	},
	"product_events:breakdown": {
		metrics: ["count", "sessions", "persons", "users", "visitors"],
		groupBys: ["event_name", "kind", "source", "host", "page_path", "service", "group", "attribute"],
	},
	// `satisfies` rather than an annotation: it checks every combination is present
	// and well-shaped while keeping the literal token types visible to callers.
} satisfies Record<`${QuerySpecSource}:${QuerySpecKind}`, TokenSet>

export const tokensFor = (source: QuerySpecSource, kind: QuerySpecKind): TokenSet =>
	TOKENS[`${source}:${kind}`]

const quote = (values: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(values, (v) => `"${v}"`),
		", ",
	)

/**
 * An actionable replacement for a raw `SchemaError`, naming the tokens valid for
 * the source/kind the agent actually chose and calling out the narrowing when the
 * value would have been accepted by the other `kind`.
 */
export const describeInvalidQuerySpec = (params: {
	readonly source: QuerySpecSource
	readonly kind: QuerySpecKind
	readonly metric: string | undefined
	readonly groupBy: string | undefined
}): { readonly message: string; readonly example: string } | undefined => {
	const { source, kind, metric, groupBy } = params
	const valid = tokensFor(source, kind)
	const otherKind: QuerySpecKind = kind === "timeseries" ? "breakdown" : "timeseries"

	if (metric !== undefined && !valid.metrics.includes(metric)) {
		const acceptedElsewhere = tokensFor(source, otherKind).metrics.includes(metric)
		const note = acceptedElsewhere
			? ` It is valid for kind="${otherKind}" but not for kind="${kind}".`
			: ""
		return {
			message: `Invalid metric "${metric}" for source="${source}" kind="${kind}".${note} Valid metrics: ${quote(valid.metrics)}.`,
			example: `source="${source}" kind="${kind}" metric="${valid.metrics[0]}"`,
		}
	}

	if (groupBy !== undefined && !valid.groupBys.includes(groupBy)) {
		const acceptedElsewhere = tokensFor(source, otherKind).groupBys.includes(groupBy)
		const note = acceptedElsewhere
			? ` It is valid for kind="${otherKind}" but not for kind="${kind}".`
			: ""
		return {
			message: `Invalid group_by "${groupBy}" for source="${source}" kind="${kind}".${note} Valid group_by values: ${quote(valid.groupBys)}.`,
			example: `source="${source}" kind="${kind}" group_by="${valid.groupBys[0]}"`,
		}
	}

	return undefined
}

/** The resource key the commit SHA filter (`commit_shas`) reads. */
const COMMIT_SHA_KEY = "vcs.ref.head.revision"

/** Spellings agents reach for that name the commit, not an attribute literally called that. */
const COMMIT_GROUP_BYS = new Set(["commit_sha", "commit", "commit_shas", "git_sha", "sha", COMMIT_SHA_KEY])

const ERROR_COUNT_METRICS = new Set(["error_count", "errors", "error_total", "errored"])

export interface TokenAliasInput {
	readonly source: QuerySpecSource
	readonly kind: QuerySpecKind
	readonly metric?: string | undefined
	readonly group_by?: string | undefined
	readonly attribute_key?: string | undefined
	readonly attribute_value?: string | undefined
}

export interface ResolvedTokenAliases {
	readonly metric?: string | undefined
	readonly group_by?: string | undefined
	readonly attribute_key?: string | undefined
	/** `metric=error_count` on traces: count only error spans. */
	readonly errorsOnly: boolean
	/** One line per rewrite, for the result's decisions list. */
	readonly decisions: ReadonlyArray<string>
}

interface Alias<T> {
	readonly value: T
	readonly decision?: string
}

const metricAlias = (
	input: TokenAliasInput,
	valid: TokenSet,
): Alias<{ metric?: string; errorsOnly: boolean }> =>
	input.source === "traces" &&
	input.metric !== undefined &&
	!valid.metrics.includes(input.metric) &&
	ERROR_COUNT_METRICS.has(input.metric)
		? {
				value: { metric: "count", errorsOnly: true },
				decision: `metric: "${input.metric}" read as metric="count" over error spans only (status Error)`,
			}
		: { value: { metric: input.metric, errorsOnly: false } }

const groupByAlias = (
	input: TokenAliasInput,
	valid: TokenSet,
): Alias<{ group_by?: string; attribute_key?: string }> => {
	const unchanged = { value: { group_by: input.group_by, attribute_key: input.attribute_key } }
	const token = input.group_by
	// A stray attribute_value stays an error ("requires attribute_key") rather than becoming a filter.
	if (
		token === undefined ||
		valid.groupBys.includes(token) ||
		input.attribute_key !== undefined ||
		input.attribute_value !== undefined
	)
		return unchanged
	// Traces have no resource_attribute token; query_data maps it onto group_by=attribute.
	const byResource = valid.groupBys.includes("resource_attribute") || input.source === "traces"
	if (COMMIT_GROUP_BYS.has(token) && byResource)
		return {
			value: { group_by: "resource_attribute", attribute_key: COMMIT_SHA_KEY },
			decision: `group_by: "${token}" read as group_by="resource_attribute" attribute_key="${COMMIT_SHA_KEY}"`,
		}
	// A dotted token is an attribute key (`http.route`, `k8s.pod.name`), never a built-in token.
	if (Str.includes(".")(token) && valid.groupBys.includes("attribute"))
		return {
			value: { group_by: "attribute", attribute_key: token },
			decision: `group_by: "${token}" read as group_by="attribute" attribute_key="${token}"`,
		}
	return unchanged
}

/**
 * Rewrites `metric`/`group_by` spellings that production agents used and the query
 * engine has no token for into the tokens that answer them, before validation.
 * A token the table already accepts is never rewritten.
 */
export const resolveTokenAliases = (input: TokenAliasInput): ResolvedTokenAliases => {
	const valid = tokensFor(input.source, input.kind)
	const metric = metricAlias(input, valid)
	const groupBy = groupByAlias(input, valid)
	return {
		...metric.value,
		...groupBy.value,
		decisions: Arr.filter([metric.decision, groupBy.decision], (d) => d !== undefined),
	}
}
