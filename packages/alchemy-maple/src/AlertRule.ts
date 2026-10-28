import { Schema } from "effect"
import * as Effect from "effect/Effect"
import { deepEqual, isResolved } from "alchemy/Diff"
import { Unowned } from "alchemy/AdoptPolicy"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import { listAll, MapleApi } from "./MapleApi"
import { MapleErrorTags } from "./errors"
import type { Providers } from "./Providers"
import type { ExclusiveVariant } from "./variants"
import {
	canAdoptRule,
	ownershipError,
	ownershipTags,
	ownsRule,
	ruleOwnerTags,
	ruleTags,
} from "./AlertRuleOwnership"

export type AlertSignalType =
	| "error_rate"
	| "p95_latency"
	| "p99_latency"
	| "apdex"
	| "throughput"
	| "builder_query"
	| "raw_query"

export type AlertComparator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "between" | "not_between"

/** Fields every alert rule takes, whatever it measures and wherever it looks. */
interface RuleBaseProps {
	/** Rule name — unique per organization. */
	name: string
	severity: "warning" | "critical"
	/** Error rates are 0–1 ratios. */
	threshold: number
	window_minutes: number
	/** `dest_…` IDs — pass `destination.destinationId` outputs from `Maple.AlertDestination`. */
	destination_ids: string[]
	notes?: string | null
	enabled?: boolean
	/** Up to 19 user tags; `alchemy:` tags are reserved for stack ownership. */
	tags?: string[]
	minimum_sample_count?: number
	consecutive_breaches_required?: number
	consecutive_healthy_required?: number
	renotify_interval_minutes?: number
	apdex_threshold_ms?: number | null
	/** Count a window with no data as a breach instead of skipping it. */
	alert_on_no_data?: boolean
	notification_template?: Record<string, unknown> | null
}

/**
 * The comparison: `between` and `not_between` need `threshold_upper`, which no
 * other comparator takes.
 */
type Comparison =
	| { comparator: "between" | "not_between"; threshold_upper: number }
	| {
			comparator: Exclude<AlertComparator, "between" | "not_between">
			threshold_upper?: null
	  }

/**
 * Which services a signal other than `builder_query` and `raw_query` reads:
 * the named ones; all of them, grouped (each group its own incident); all of
 * them grouped by `service.name` minus some; or all of them, ungrouped. A
 * grouped rule cannot alert on no data. Leaving a field out clears it, as
 * `null` and `[]` do.
 */
type Scope =
	| { service_names: string[]; group_by?: null; exclude_service_names?: [] }
	| {
			group_by: string[]
			service_names?: []
			exclude_service_names?: []
			alert_on_no_data?: false
	  }
	| {
			group_by: ["service.name"]
			exclude_service_names: string[]
			service_names?: []
			alert_on_no_data?: false
	  }
	| { service_names?: []; group_by?: null; exclude_service_names?: [] }

/**
 * What the rule measures. `builder_query` takes its draft, which carries its
 * own scope, so the API drops `service_names` and `exclude_service_names`;
 * grouped, it cannot alert on no data either.
 * `raw_query` takes its SQL, which returns its own groups, so it reads no
 * services and groups by none. Every other signal takes neither.
 */
type Measure =
	| ({
			signal_type: Exclude<AlertSignalType, "builder_query" | "raw_query">
			query_builder_draft?: null
			raw_query_sql?: null
			raw_query_reducer?: null
	  } & Scope)
	| ({
			signal_type: "builder_query"
			/** Opaque query-builder draft (verbatim passthrough). */
			query_builder_draft: Record<string, unknown>
			raw_query_sql?: null
			raw_query_reducer?: null
	  } & ({ group_by: string[]; alert_on_no_data?: false } | { group_by?: null }))
	| {
			signal_type: "raw_query"
			raw_query_sql: string
			raw_query_reducer?: "identity" | "sum" | "avg" | "min" | "max" | null
			query_builder_draft?: null
			service_names?: []
			group_by?: null
			exclude_service_names?: []
	  }

/**
 * Alert rule props, authored in the v2 wire shape — mirrors
 * `POST /v2/alerts/rules`. Discriminated so that a combination the API
 * rejects fails to type-check instead of failing the deploy: by `signal_type`
 * for the query fields, by scope for `service_names`, `group_by` and
 * `exclude_service_names`, and by `comparator` for `threshold_upper`.
 */
export type AlertRuleProps = ExclusiveVariant<RuleBaseProps & Comparison & Measure>

export type AlertRule = Resource<
	"Maple.AlertRule",
	AlertRuleProps,
	{
		/** The `alrt_…` public ID. */
		ruleId: string
		name: string
		enabled: boolean
		/** Observed declared fields and ownership tags, used by Alchemy sync. */
		configuration?: Record<string, unknown>
	},
	never,
	Providers
>

/**
 * A Maple alert rule managed through the public v2 API. Reference the
 * destinations it notifies by their `dest_…` IDs — typically outputs of
 * `Maple.AlertDestination` resources, which Alchemy resolves and orders
 * automatically.
 *
 * @example
 * ```typescript
 * const oncall = yield* Maple.AlertDestination("oncall", { ... })
 * yield* Maple.AlertRule("checkout-errors", {
 *   name: "Checkout error rate",
 *   severity: "critical",
 *   signal_type: "error_rate",
 *   comparator: "gt",
 *   threshold: 0.05,
 *   window_minutes: 5,
 *   destination_ids: [oncall.destinationId],
 * })
 * ```
 */
export const AlertRule = Resource<AlertRule>("Maple.AlertRule")

const WireRule = Schema.StructWithRest(
	Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		enabled: Schema.Boolean,
		tags: Schema.Array(Schema.String),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)],
)
const decodeWireRule = Schema.decodeUnknownEffect(WireRule)

/**
 * Fields the API validates together. PATCH keeps any field it is not sent, so
 * an undeclared one goes out as its default, or a field dropped from props
 * would outlive the deploy and clash with the ones that replaced it.
 */
const scopeDefaults = {
	service_names: [],
	exclude_service_names: [],
	group_by: null,
	alert_on_no_data: false,
} satisfies Partial<Record<keyof AlertRuleProps, unknown>>

/** The create/update body: the props the user declared, plus scope defaults. */
const desiredBody = (props: AlertRuleProps): Record<string, unknown> => ({
	...scopeDefaults,
	...Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)),
})

/** Wire drift compare: declared fields vs the observed wire rule. */
const drifted = (body: Record<string, unknown>, observed: Record<string, unknown>): boolean => {
	return Object.keys(body).some((key) => !deepEqual(body[key], observed[key], { stripNullish: true }))
}

const toAttributes = (observed: Schema.Schema.Type<typeof WireRule>, props?: AlertRuleProps) => ({
	ruleId: observed.id,
	name: observed.name,
	enabled: observed.enabled,
	configuration: {
		...Object.fromEntries(
			Object.keys(props ? desiredBody(props) : {}).map((key) => [key, observed[key]]),
		),
		// Observe ownership even when the user leaves ordinary tags unmanaged.
		tags: props?.tags === undefined ? ownershipTags(observed.tags) : observed.tags,
	},
})

export const AlertRuleProvider = () =>
	Provider.effect(
		AlertRule,
		Effect.gen(function* () {
			const api = yield* MapleApi

			/** A name locates a candidate; its ownership tags decide whether it is ours. */
			const findByName = (name: string) =>
				Effect.gen(function* () {
					const items = yield* listAll(api, "/v2/alerts/rules")
					const match = items.find(
						(item) =>
							typeof item === "object" &&
							item !== null &&
							(item as { name?: unknown }).name === name,
					)
					return match === undefined ? undefined : yield* decodeWireRule(match)
				})

			return {
				stables: ["ruleId" as const],
				diff: Effect.fn(function* ({ news, olds, output }) {
					// Add snapshots and ownership to resources from pre-tag releases.
					if (output && output.configuration === undefined) return { action: "update" } as const
					if (!isResolved(news)) return undefined
					if (olds !== undefined && !deepEqual(olds, news, { stripNullish: true })) {
						return { action: "update", stables: ["ruleId"] } as const
					}
					return undefined
				}),
				reconcile: Effect.fn(function* ({ news, output, fqn }) {
					const owners = yield* ruleOwnerTags(fqn)
					let observedRaw: unknown
					if (output?.ruleId) {
						observedRaw = yield* api
							.get(`/v2/alerts/rules/${output.ruleId}`)
							.pipe(
								Effect.catchTag(MapleErrorTags.alertRuleNotFound, () =>
									Effect.succeed(undefined),
								),
							)
					}
					if (observedRaw === undefined) {
						const adopted = yield* findByName(news.name)
						if (adopted !== undefined) {
							observedRaw = yield* api.get(`/v2/alerts/rules/${adopted.id}`)
						}
					}

					const current = observedRaw === undefined ? undefined : yield* decodeWireRule(observedRaw)
					// Plan can skip read for unresolved upstream inputs; enforce ownership
					// here too, before any mutation or name-based recovery.
					if (current && !ownsRule(current.tags, owners, output?.ruleId === current.id)) {
						if (!(yield* canAdoptRule(fqn))) return yield* ownershipError(fqn, current.name)
					}
					const body = {
						...desiredBody(news),
						tags: yield* ruleTags(news.tags, current?.tags ?? [], owners[0]),
					}
					if (current === undefined) {
						observedRaw = yield* api.post("/v2/alerts/rules", body)
					} else if (drifted(body, current)) {
						observedRaw = yield* api.patch(`/v2/alerts/rules/${current.id}`, body)
					}

					return toAttributes(yield* decodeWireRule(observedRaw), news)
				}),
				delete: Effect.fn(function* ({ output, fqn, force }) {
					// A previous owner must not delete a rule another stack has adopted.
					if (!force) {
						const fetched = yield* api
							.get(`/v2/alerts/rules/${output.ruleId}`)
							.pipe(
								Effect.catchTag(MapleErrorTags.alertRuleNotFound, () =>
									Effect.succeed(undefined),
								),
							)
						if (fetched === undefined) return
						const current = yield* decodeWireRule(fetched)
						if (!ownsRule(current.tags, yield* ruleOwnerTags(fqn), true)) {
							return yield* ownershipError(fqn, current.name)
						}
					}
					yield* api
						.delete(`/v2/alerts/rules/${output.ruleId}`)
						.pipe(Effect.catchTag(MapleErrorTags.alertRuleNotFound, () => Effect.void))
				}),
				read: Effect.fn(function* ({ olds, output, fqn }) {
					const owners = yield* ruleOwnerTags(fqn)
					const attributes = (observed: Schema.Schema.Type<typeof WireRule>) => {
						const result = toAttributes(observed, olds)
						return ownsRule(observed.tags, owners, output?.ruleId === observed.id)
							? result
							: Unowned(result)
					}
					if (output?.ruleId) {
						const fetched = yield* api
							.get(`/v2/alerts/rules/${output.ruleId}`)
							.pipe(
								Effect.catchTag(MapleErrorTags.alertRuleNotFound, () =>
									Effect.succeed(undefined),
								),
							)
						if (fetched !== undefined) return attributes(yield* decodeWireRule(fetched))
					}
					if (olds?.name !== undefined) {
						const adopted = yield* findByName(olds.name)
						if (adopted !== undefined) return attributes(adopted)
					}
					return undefined
				}),
				list: Effect.fn(function* () {
					const items = yield* listAll(api, "/v2/alerts/rules")
					return yield* Effect.forEach(items, (item) =>
						Effect.map(decodeWireRule(item), (observed) => toAttributes(observed)),
					)
				}),
			}
		}),
	)

/** @internal Exposed for the in-repo contract test against `@maple/domain`. */
export const _alertRuleCreateBody = desiredBody
