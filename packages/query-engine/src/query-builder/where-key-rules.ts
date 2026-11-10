import { normalizeKey, type Operator } from "@maple/domain/where-clause"
import type { QueryBuilderDataSource } from "@maple/query-model"
import { Option, Record as Rec, String as Str } from "effect"

// Which where-clause operators each source's clause handler (`apply*Clause` in `model.ts`)
// accepts per key. Editors read it so they never offer a clause the query drops with a
// warning; `where-key-rules.test.ts` holds it to the handlers in both directions.

/** Every grammar operator, in the order editors list them; the test holds it to the domain's literals. */
export const WHERE_OPERATORS: ReadonlyArray<Operator> = [
	"=",
	"!=",
	">",
	">=",
	"<",
	"<=",
	"contains",
	"!contains",
	"exists",
	"!exists",
]

/**
 * A key's rule: a column-backed `Dimension` takes its listed operators; an `Attribute`
 * (a map key) takes every operator; an `Unsupported` key is dropped by the source.
 */
export type WhereKeyRule =
	| Readonly<{ _tag: "Dimension"; operators: ReadonlyArray<Operator> }>
	| Readonly<{ _tag: "Attribute" }>
	| Readonly<{ _tag: "Unsupported" }>

const EQUALS: ReadonlyArray<Operator> = ["="]
const EQUALS_OR_NOT: ReadonlyArray<Operator> = ["=", "!="]
const TRACES_DIMENSION: ReadonlyArray<Operator> = ["=", "!=", "contains"]
const LOGS_BODY: ReadonlyArray<Operator> = ["=", "contains"]

const PRODUCT_EVENT_LIST_KEYS = [
	"event.name",
	"event",
	"event_name",
	"event.kind",
	"kind",
	"source",
	"host",
	"page.path",
	"page_path",
	"path",
	"service.name",
	"service",
]

const PRODUCT_EVENT_EQUALS_KEYS = [
	"user.id",
	"group.id",
	"referrer.host",
	"referrer_host",
	"referrer",
	"country",
	"device.type",
	"device_type",
	"device",
	"browser",
	"browser.name",
	"os",
	"os.name",
	"language",
	"utm.source",
	"utm_source",
	"utm.medium",
	"utm_medium",
	"utm.campaign",
	"utm_campaign",
	"visitor.type",
	"visitor_type",
]

/** Column-backed keys by source, after `normalizeKey`. */
export const WHERE_DIMENSIONS = {
	traces: {
		"service.name": TRACES_DIMENSION,
		"span.name": TRACES_DIMENSION,
		"deployment.environment": TRACES_DIMENSION,
		"vcs.ref.head.revision": EQUALS_OR_NOT,
		root_only: EQUALS,
		has_error: EQUALS,
		min_duration_ms: EQUALS,
		max_duration_ms: EQUALS,
	},
	logs: {
		"service.name": EQUALS_OR_NOT,
		severity: EQUALS_OR_NOT,
		body: LOGS_BODY,
		message: LOGS_BODY,
		search: LOGS_BODY,
	},
	metrics: {
		"service.name": EQUALS,
		"deployment.environment": EQUALS,
		"metric.type": EQUALS,
	},
	product_events: {
		...Rec.fromIterableWith(PRODUCT_EVENT_LIST_KEYS, (key) => [key, EQUALS_OR_NOT]),
		...Rec.fromIterableWith(PRODUCT_EVENT_EQUALS_KEYS, (key) => [key, EQUALS]),
	},
} satisfies Record<QueryBuilderDataSource, Record<string, ReadonlyArray<Operator>>>

/** One source's dimensions, read by any key. */
const dimensionsOf = (
	dataSource: QueryBuilderDataSource,
): Readonly<Record<string, ReadonlyArray<Operator>>> => WHERE_DIMENSIONS[dataSource]

/** The rule for a key as written (aliases resolve), on one source. */
export const whereKeyRule = (dataSource: QueryBuilderDataSource, key: string): WhereKeyRule => {
	const canonical = normalizeKey(key)
	if (Str.startsWith("attr.")(canonical)) return { _tag: "Attribute" }
	// Product events have no resource attributes: their handler would read the key as a prop of that literal name.
	if (Str.startsWith("resource.")(canonical))
		return dataSource === "product_events" ? { _tag: "Unsupported" } : { _tag: "Attribute" }
	return Option.match(Rec.get(dimensionsOf(dataSource), canonical), {
		onSome: (operators): WhereKeyRule => ({ _tag: "Dimension", operators }),
		// Traces read a bare key as a span attribute and product events as a `track()` prop.
		onNone: (): WhereKeyRule =>
			dataSource === "traces" || dataSource === "product_events"
				? { _tag: "Attribute" }
				: { _tag: "Unsupported" },
	})
}

/** The operators a key takes on a source: none when the source drops it. */
export const whereOperatorsOf = (
	dataSource: QueryBuilderDataSource,
	key: string,
): ReadonlyArray<Operator> => {
	const rule = whereKeyRule(dataSource, key)
	return rule._tag === "Dimension" ? rule.operators : rule._tag === "Attribute" ? WHERE_OPERATORS : []
}

/** Whether `(k = a OR k = b)` on this key is lowered: attribute filters only, on sources that lower groups. */
export const whereKeyMatchesAnyOf = (dataSource: QueryBuilderDataSource, key: string): boolean =>
	dataSource !== "product_events" && whereKeyRule(dataSource, key)._tag === "Attribute"
