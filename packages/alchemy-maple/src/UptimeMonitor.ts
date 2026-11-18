import { Schema, Array as Arr, Record as Rec } from "effect"
import * as Effect from "effect/Effect"
import { deepEqual, isResolved } from "alchemy/Diff"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import { listAll, MapleApi } from "./MapleApi"
import { MapleErrorTags } from "./errors"
import type { Providers } from "./Providers"

export type UptimeMonitorKind = "http" | "tcp" | "dns" | "multistep" | "heartbeat"

/**
 * Uptime monitor props, in the v2 `POST /v2/uptime_monitors` wire shape. The
 * monitor's kind is `config.type`; changing it replaces the monitor.
 */
export interface UptimeMonitorProps {
	name: string
	/**
	 * The check, as documented at `/v2/docs`, e.g.
	 * `{ type: "http", url: "https://api.example.com/health" }` or
	 * `{ type: "heartbeat", schedule: { type: "interval", seconds: 3600 }, grace_seconds: 300 }`.
	 */
	config: { readonly type: UptimeMonitorKind } & Record<string, unknown>
	/** Seconds between checks, 30 to 3600. */
	interval_seconds?: number
	/** Failed checks in a row before the monitor is down, 1 to 10. */
	failures_to_down?: number
	/** The service the monitor belongs to. */
	service_name?: string | null
	/** Whether checks run. Defaults to `true`. */
	enabled?: boolean
	/** `dest_…` IDs notified when the monitor goes down or recovers. */
	destination_ids?: ReadonlyArray<string>
}

export type UptimeMonitor = Resource<
	"Maple.UptimeMonitor",
	UptimeMonitorProps,
	{
		/** The `upm_…` public ID; reference it from a `Maple.StatusPage` component's `monitor_id`. */
		monitorId: string
		name: string
		kind: string
		/** Heartbeats only: the URL your job pings. */
		heartbeatUrl: string | null
		/** The alert rule that delivers this monitor's notifications. */
		alertRuleId: string | null
		/** Observed declared fields, used by Alchemy sync to detect drift. */
		configuration: Record<string, unknown>
	},
	never,
	Providers
>

/**
 * An HTTP, TCP, DNS, multi-step or heartbeat uptime monitor.
 *
 * @example
 * ```typescript
 * const api = yield* Maple.UptimeMonitor("api", {
 *   name: "API health",
 *   config: { type: "http", url: "https://api.example.com/health" },
 * })
 * ```
 */
export const UptimeMonitor = Resource<UptimeMonitor>("Maple.UptimeMonitor")

const WireMonitor = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	kind: Schema.String,
	config: Schema.Record(Schema.String, Schema.Unknown),
	interval_seconds: Schema.Number,
	failures_to_down: Schema.Number,
	service_name: Schema.NullOr(Schema.String),
	enabled: Schema.Boolean,
	destination_ids: Schema.Array(Schema.String),
	heartbeat_url: Schema.NullOr(Schema.String),
	alert_rule_id: Schema.NullOr(Schema.String),
})
type WireMonitor = Schema.Schema.Type<typeof WireMonitor>
const decodeWireMonitor = Schema.decodeUnknownEffect(WireMonitor)

/** The update body. Removing an optional prop clears it; unset timings keep the API's. */
const desiredBody = (props: UptimeMonitorProps): Record<string, unknown> =>
	Rec.filter(
		{
			name: props.name,
			config: props.config,
			interval_seconds: props.interval_seconds,
			failures_to_down: props.failures_to_down,
			service_name: props.service_name ?? null,
			enabled: props.enabled ?? true,
			destination_ids: props.destination_ids ?? [],
		},
		(value) => value !== undefined,
	)

const createBody = (props: UptimeMonitorProps) => ({
	...desiredBody(props),
	kind: props.config.type,
})

/** Whether every value written in `want` is present and equal in `got`; the API adds defaults. */
const covers = (want: unknown, got: unknown): boolean => {
	if (Arr.isArray(want)) {
		return (
			Arr.isArray(got) &&
			got.length === want.length &&
			Arr.every(want, (item, i) => covers(item, got[i]))
		)
	}
	if (typeof want === "object" && want !== null) {
		if (typeof got !== "object" || got === null) return false
		const seen = got as Record<string, unknown>
		return Arr.every(Rec.toEntries(want as Record<string, unknown>), ([key, value]) =>
			covers(value, seen[key]),
		)
	}
	return deepEqual(want, got)
}

const toAttributes = (observed: WireMonitor, props?: UptimeMonitorProps) => {
	const seen = { ...observed }
	return {
		monitorId: observed.id,
		name: observed.name,
		kind: observed.kind,
		heartbeatUrl: observed.heartbeat_url,
		alertRuleId: observed.alert_rule_id,
		configuration: Rec.fromEntries(
			Arr.map(Rec.keys(props === undefined ? { name: 1 } : desiredBody(props)), (key) => [
				key,
				seen[key as keyof typeof seen],
			]),
		),
	}
}

export const UptimeMonitorProvider = () =>
	Provider.effect(
		UptimeMonitor,
		Effect.gen(function* () {
			const api = yield* MapleApi
			const fetch = (monitorId: string) =>
				api.get(`/v2/uptime_monitors/${encodeURIComponent(monitorId)}`).pipe(
					Effect.catchTag(MapleErrorTags.uptimeMonitorNotFound, () => Effect.undefined),
					Effect.flatMap((fetched) =>
						fetched === undefined ? Effect.undefined : decodeWireMonitor(fetched),
					),
				)
			return {
				stables: ["monitorId" as const],
				diff: Effect.fn(function* ({ news, olds, output }) {
					if (!isResolved(news)) return undefined
					// The kind cannot change server-side.
					if (output !== undefined && news.config.type !== output.kind)
						return { action: "replace" } as const
					if (olds !== undefined && !deepEqual(olds, news, { stripNullish: true })) {
						return { action: "update", stables: ["monitorId"] } as const
					}
					return undefined
				}),
				reconcile: Effect.fn(function* ({ news, olds, output }) {
					let observed = output === undefined ? undefined : yield* fetch(output.monitorId)
					if (observed === undefined) {
						observed = yield* api
							.post("/v2/uptime_monitors", createBody(news))
							.pipe(Effect.flatMap(decodeWireMonitor))
					} else if (
						// A changed prop is sent whole: `covers` cannot see a config key that was removed.
						olds === undefined ||
						!deepEqual(olds, news, { stripNullish: true }) ||
						!covers(desiredBody(news), observed)
					) {
						observed = yield* api
							.patch(`/v2/uptime_monitors/${observed.id}`, desiredBody(news))
							.pipe(Effect.flatMap(decodeWireMonitor))
					}
					return toAttributes(observed, news)
				}),
				delete: Effect.fn(function* ({ output }) {
					yield* api
						.delete(`/v2/uptime_monitors/${output.monitorId}`)
						.pipe(Effect.catchTag(MapleErrorTags.uptimeMonitorNotFound, () => Effect.void))
				}),
				read: Effect.fn(function* ({ output, olds }) {
					if (output === undefined) return undefined
					const observed = yield* fetch(output.monitorId)
					return observed === undefined ? undefined : toAttributes(observed, olds)
				}),
				list: Effect.fn(function* () {
					const items = yield* listAll(api, "/v2/uptime_monitors")
					return yield* Effect.forEach(items, (item) =>
						Effect.map(decodeWireMonitor(item), (observed) => toAttributes(observed)),
					)
				}),
			}
		}),
	)

/** @internal Exposed for the in-repo contract test against `@maple/domain`. */
export const _uptimeMonitorCreateBody = createBody
