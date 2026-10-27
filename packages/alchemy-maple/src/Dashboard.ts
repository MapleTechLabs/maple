import { Schema } from "effect"
import * as Effect from "effect/Effect"
import { deepEqual, isResolved } from "alchemy/Diff"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import { listAll, MapleApi } from "./MapleApi"
import { MapleDashboardIdentityError, MapleErrorTags } from "./errors"
import type { DashboardData } from "./DashboardData"
import type { Providers } from "./Providers"

/**
 * Dashboard props, authored in the v2 wire shape (snake_case, exactly as
 * documented at `/v2/docs`). `widgets`, `sections`, `variables`, and
 * `time_range` are passed through verbatim.
 */
export interface DashboardProps extends DashboardData {
	/**
	 * Adopt this existing `dash_…` public ID instead of creating a dashboard.
	 * It must exist, and cannot be changed after this resource is deployed.
	 * Omit it to let Alchemy create and remember a new dashboard.
	 */
	dashboardId?: string
}

export type Dashboard = Resource<
	"Maple.Dashboard",
	DashboardProps,
	{
		/** The `dash_…` public ID. */
		dashboardId: string
		name: string
		/** Observed declared fields, used by Alchemy sync to detect drift. */
		configuration?: Record<string, unknown>
	},
	never,
	Providers
>

/**
 * A Maple dashboard managed through the public v2 API.
 *
 * @example
 * ```typescript
 * const dash = yield* Maple.Dashboard("service-health", {
 *   name: "Service health",
 *   widgets: [...],
 * })
 * ```
 */
export const Dashboard = Resource<Dashboard>("Maple.Dashboard")

/** Decode just the wire fields the provider stores/compares. */
const WireDashboard = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	tags: Schema.Array(Schema.String),
	time_range: Schema.Record(Schema.String, Schema.Unknown),
	widgets: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	// Optional, unlike its siblings: an IaC client has its own release cadence and
	// routinely runs against a Maple API older than itself. A required field here
	// would make `alchemy deploy` fail to decode every dashboard served by a
	// deployment that predates sections. `drifted` reads it as `[]` when absent,
	// which is what such an API means anyway.
	sections: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
	variables: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	refresh_interval_seconds: Schema.optionalKey(Schema.NullOr(Schema.Number)),
})
const decodeWireDashboard = Schema.decodeUnknownEffect(WireDashboard)

/** The request body for create/update: exactly the props the user set. */
const desiredBody = (props: DashboardProps) => ({
	name: props.name,
	...(props.description !== undefined ? { description: props.description } : undefined),
	...(props.tags !== undefined ? { tags: props.tags } : undefined),
	...(props.time_range !== undefined ? { time_range: props.time_range } : undefined),
	...(props.widgets !== undefined ? { widgets: props.widgets } : undefined),
	...(props.sections !== undefined ? { sections: props.sections } : undefined),
	...(props.variables !== undefined ? { variables: props.variables } : undefined),
	...(props.refresh_interval_seconds !== undefined
		? { refresh_interval_seconds: props.refresh_interval_seconds }
		: undefined),
})

/** Compare only the fields the user declared against the observed wire object. */
const drifted = (props: DashboardProps, observed: Schema.Schema.Type<typeof WireDashboard>): boolean => {
	const body = desiredBody(props) as Record<string, unknown>
	// An API that predates sections omits the key entirely; treat that as "no
	// groups" so declaring `sections: []` doesn't read as perpetual drift.
	const seen: Record<string, unknown> = {
		...(observed as Record<string, unknown>),
		sections: observed.sections ?? [],
	} satisfies Record<string, unknown>
	return Object.keys(body).some((key) => !deepEqual(body[key], seen[key], { stripNullish: true }))
}

const toAttributes = (
	observed: Schema.Schema.Type<typeof WireDashboard>,
	props: DashboardProps = { name: observed.name },
) => {
	const seen = { ...observed, sections: observed.sections ?? [] }
	return {
		dashboardId: observed.id,
		name: observed.name,
		configuration: Object.fromEntries(
			Object.keys(desiredBody(props)).map((key) => [key, seen[key as keyof typeof seen]]),
		),
	}
}

export const DashboardProvider = () =>
	Provider.effect(
		Dashboard,
		Effect.gen(function* () {
			const api = yield* MapleApi
			return {
				stables: ["dashboardId" as const],
				diff: Effect.fn(function* ({ news, olds, output }) {
					// Populate snapshots for resources deployed by older provider versions.
					if (output && output.configuration === undefined) return { action: "update" } as const
					if (!isResolved(news)) return undefined
					if (olds !== undefined && !deepEqual(olds, news, { stripNullish: true })) {
						return { action: "update", stables: ["dashboardId"] } as const
					}
					return undefined
				}),
				reconcile: Effect.fn(function* ({ news, output }) {
					if (
						news.dashboardId !== undefined &&
						output !== undefined &&
						news.dashboardId !== output.dashboardId
					) {
						return yield* new MapleDashboardIdentityError({
							message:
								"A managed dashboard's ID cannot be changed; declare a separate resource.",
							dashboardId: output.dashboardId,
							requestedId: news.dashboardId,
						})
					}
					let observed: Schema.Schema.Type<typeof WireDashboard> | undefined
					const dashboardId = news.dashboardId ?? output?.dashboardId
					if (dashboardId !== undefined) {
						const fetched = yield* api
							.get(`/v2/dashboards/${encodeURIComponent(dashboardId)}`)
							.pipe(
								Effect.catchTag(MapleErrorTags.dashboardNotFound, (error) =>
									news.dashboardId !== undefined
										? Effect.fail(error)
										: Effect.succeed(undefined),
								),
							)
						if (fetched !== undefined) observed = yield* decodeWireDashboard(fetched)
					}

					if (observed === undefined) {
						const created = yield* api.post("/v2/dashboards", desiredBody(news))
						observed = yield* decodeWireDashboard(created)
					} else if (drifted(news, observed)) {
						const updated = yield* api.patch(`/v2/dashboards/${observed.id}`, desiredBody(news))
						observed = yield* decodeWireDashboard(updated)
					}

					return toAttributes(observed, news)
				}),
				delete: Effect.fn(function* ({ output }) {
					yield* api
						.delete(`/v2/dashboards/${output.dashboardId}`)
						.pipe(Effect.catchTag(MapleErrorTags.dashboardNotFound, () => Effect.void))
				}),
				read: Effect.fn(function* ({ output, olds }) {
					const dashboardId = olds.dashboardId ?? output?.dashboardId
					if (dashboardId === undefined) return undefined
					const fetched = yield* api
						.get(`/v2/dashboards/${encodeURIComponent(dashboardId)}`)
						.pipe(
							Effect.catchTag(MapleErrorTags.dashboardNotFound, (error) =>
								olds.dashboardId !== undefined
									? Effect.fail(error)
									: Effect.succeed(undefined),
							),
						)
					if (fetched === undefined) return undefined
					return toAttributes(yield* decodeWireDashboard(fetched), olds)
				}),
				list: Effect.fn(function* () {
					const items = yield* listAll(api, "/v2/dashboards")
					return yield* Effect.forEach(items, (item) =>
						Effect.map(decodeWireDashboard(item), (observed) => toAttributes(observed)),
					)
				}),
			}
		}),
	)

/** @internal Exposed for the in-repo contract test against `@maple/domain`. */
export const _dashboardCreateBody = desiredBody
