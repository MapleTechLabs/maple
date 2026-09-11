// Which signals is this org actually sending?
//
// Every empty view in the product needs this before it can give advice. "No logs
// found" is the wrong thing to say to an org that has never wired a log bridge
// AND to one whose logs simply went quiet for ten minutes; the two need opposite
// next steps. This service is the input that separates them.
//
// Two deliberate properties:
//
//   Cheap. Traces, logs and metrics come from `service_usage`, the hourly
//   per-service rollup, not the raw signal tables. Sessions and product events
//   have no equivalent rollup but are narrow tables to begin with.
//
//   Never fails. A warehouse outage returns every signal as `unknown` rather than
//   an error. The alternative is an empty state that breaks the page it was added
//   to help — and this runs on views that are, by definition, already not working
//   for the user.

import { Clock, Context, Effect, Layer, Option } from "effect"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import type { TenantContext } from "@/services/auth/AuthService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

/**
 * How far back presence is evaluated.
 *
 * Thirty days, not "ever". `service_usage` is small, but an unbounded scan still
 * grows without limit and the extra reach buys nothing: a signal last sent two
 * months ago is not wired up *now*, which is the only thing the advice turns on.
 * The wire contract says so explicitly so callers do not read `absent` as `never`.
 */
const WINDOW_DAYS = 30

/** ClickHouse's zero date, which `min`/`max` return over an empty set. */
const CH_EPOCH = "1970-01-01 00:00:00"

export const TELEMETRY_SIGNALS = [
	"traces",
	"logs",
	"metrics",
	"sessions",
	"product_events",
] as const satisfies ReadonlyArray<CH.TelemetrySignal>

export interface SignalPresence {
	readonly signal: CH.TelemetrySignal
	readonly status: "present" | "absent" | "unknown"
	readonly count: number | null
	readonly firstSeen: number | null
	readonly lastSeen: number | null
}

export interface SignalPresenceReport {
	readonly generatedAt: number
	readonly windowStart: number
	readonly windowEnd: number
	readonly warehouseAvailable: boolean
	readonly signals: ReadonlyArray<SignalPresence>
}

export interface SignalPresenceServiceApi {
	readonly read: (tenant: TenantContext) => Effect.Effect<SignalPresenceReport>
}

/**
 * ClickHouse hands back a naive datetime literal in UTC. `Date.parse` reads a
 * bare `YYYY-MM-DD HH:MM:SS` as *local* time, which silently shifts every
 * timestamp by the server's offset — so pin the zone rather than trusting the
 * default.
 */
const parseWarehouseTime = (value: string): number | null => {
	if (value === "" || value.startsWith(CH_EPOCH)) return null
	const ms = Date.parse(`${value.replace(" ", "T")}Z`)
	return Number.isNaN(ms) ? null : ms
}

const unknown = (signal: CH.TelemetrySignal): SignalPresence => ({
	signal,
	status: "unknown",
	count: null,
	firstSeen: null,
	lastSeen: null,
})

const absent = (signal: CH.TelemetrySignal): SignalPresence => ({
	signal,
	status: "absent",
	count: 0,
	firstSeen: null,
	lastSeen: null,
})

const make: Effect.Effect<SignalPresenceServiceApi, never, WarehouseQueryService> = Effect.gen(function* () {
	const warehouse = yield* WarehouseQueryService

	const read = Effect.fn("SignalPresenceService.read")(function* (tenant: TenantContext) {
		const now = yield* Clock.currentTimeMillis
		const windowStart = now - WINDOW_DAYS * 24 * 60 * 60 * 1000

		const compiled = CH.compileUnion(CH.signalPresenceQuery(), {
			orgId: tenant.orgId,
			startTime: formatWarehouseDateTime(windowStart),
			endTime: formatWarehouseDateTime(now),
		})

		// `catchCause` rather than `Effect.option`, for the same reason the setup
		// audit uses it: a driver-level defect should degrade this to "unknown",
		// not 500 a view that is already failing the user.
		const rows = yield* warehouse
			.compiledQuery(tenant, compiled, { profile: "discovery", context: "signalPresence" })
			.pipe(
				Effect.map(Option.some),
				Effect.catchCause((cause) =>
					Effect.logWarning("Signal presence unavailable — warehouse read failed").pipe(
						Effect.annotateLogs({ orgId: tenant.orgId, cause }),
						Effect.as(Option.none()),
					),
				),
			)

		if (Option.isNone(rows)) {
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"signals.warehouseAvailable": false,
			})
			return {
				generatedAt: now,
				windowStart,
				windowEnd: now,
				warehouseAvailable: false,
				signals: TELEMETRY_SIGNALS.map(unknown),
			} satisfies SignalPresenceReport
		}

		const bySignal = new Map(rows.value.map((row) => [row.signal, row]))

		// The union always emits one group-less row per branch, so a signal that
		// is missing here means the query changed shape — report it as `absent`
		// rather than dropping the entry, because the wire contract promises the
		// full set and a caller that indexes by signal would otherwise read
		// `undefined` as "unknown" and silently stop advising.
		const signals = TELEMETRY_SIGNALS.map((signal): SignalPresence => {
			const row = bySignal.get(signal)
			if (row === undefined || row.count === 0) return absent(signal)
			return {
				signal,
				status: "present",
				count: row.count,
				firstSeen: parseWarehouseTime(row.firstSeen),
				lastSeen: parseWarehouseTime(row.lastSeen),
			}
		})

		yield* Effect.annotateCurrentSpan({
			orgId: tenant.orgId,
			"signals.warehouseAvailable": true,
			"signals.present": signals.filter((s) => s.status === "present").length,
		})

		return {
			generatedAt: now,
			windowStart,
			windowEnd: now,
			warehouseAvailable: true,
			signals,
		} satisfies SignalPresenceReport
	})

	return { read } satisfies SignalPresenceServiceApi
})

export class SignalPresenceService extends Context.Service<SignalPresenceService, SignalPresenceServiceApi>()(
	"@maple/api/services/SignalPresenceService",
	{ make },
) {
	static readonly layer = Layer.effect(this, make)
}
