import { UptimeMonitorId } from "@maple/domain"
import {
	UptimeMonitorPublicId,
	V2UptimeMonitorCreateParams,
	V2UptimeMonitorTestParams,
	V2UptimeMonitorUpdateParams,
} from "@maple/domain/http/v2"
import { Effect, Option, Schema } from "effect"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { AppRoute, hrefOf } from "../../../route"
import type { AlertsUptimeNewSearch } from "../../../route/search"

// The uptime monitor reads and writes, as Effects the pages' Commands wrap, and their links.

export const UPTIME_LIST_LIMIT = 100

/** `uptimeMonitors.list`: the org's monitors, newest first. */
export const listMonitors = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	const response = yield* client.uptimeMonitors.list({ query: { limit: UPTIME_LIST_LIMIT } })
	return response.data
}).pipe(Effect.mapError(toLoadFailure))

export const retrieveMonitor = (id: UptimeMonitorId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.uptimeMonitors.retrieve({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

/** `enabled: false` pauses, `true` resumes. */
export const setMonitorEnabled = (id: UptimeMonitorId, enabled: boolean) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.uptimeMonitors.update({ params: { id }, payload: { enabled } })
	}).pipe(Effect.mapError(toLoadFailure))

export const deleteMonitor = (id: UptimeMonitorId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		yield* client.uptimeMonitors.delete({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

/** Runs one HTTP check now with a config the caller built as plain data. */
export const testMonitorConfig = (raw: unknown) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const payload = yield* Schema.decodeUnknownEffect(V2UptimeMonitorTestParams)(raw)
		return yield* client.uptimeMonitors.test({ payload })
	}).pipe(Effect.mapError(toLoadFailure))

/** Creates a monitor, or updates `editingId`; the raw payload is validated before it is sent. */
export const saveMonitor = (editingId: UptimeMonitorId | null, raw: unknown) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		if (editingId !== null) {
			const payload = yield* Schema.decodeUnknownEffect(V2UptimeMonitorUpdateParams)(raw)
			return yield* client.uptimeMonitors.update({ params: { id: editingId }, payload })
		}
		const payload = yield* Schema.decodeUnknownEffect(V2UptimeMonitorCreateParams)(raw)
		return yield* client.uptimeMonitors.create({ payload })
	}).pipe(Effect.mapError(toLoadFailure))

/** The plan's monitor allowance is used up (402 `uptime_monitor_limit_reached`). */
export const LIMIT_REACHED_CODE = "uptime_monitor_limit_reached"

// LINKS

const encodePublicId = Schema.encodeSync(UptimeMonitorPublicId)
const decodePublicId = Schema.decodeUnknownOption(UptimeMonitorPublicId)
const decodeInternalId = Schema.decodeUnknownOption(UptimeMonitorId)

/** The `upm_…` id in a URL, or a raw UUID, as the internal id. */
export const monitorIdFromUrl = (raw: string): Option.Option<UptimeMonitorId> =>
	Option.orElse(decodePublicId(raw), () => decodeInternalId(raw))

export const monitorHref = (id: UptimeMonitorId): string =>
	hrefOf(AppRoute.AlertsUptimeMonitor({ monitorId: encodePublicId(id), search: {} }))

export const newMonitorHref = (search: typeof AlertsUptimeNewSearch.Type = {}): string =>
	hrefOf(AppRoute.AlertsUptimeNew({ search }))

export const editMonitorHref = (id: UptimeMonitorId): string =>
	newMonitorHref({ monitorId: encodePublicId(id) })

export const uptimeTabHref = (): string => hrefOf(AppRoute.Alerts({ search: { tab: "uptime" } }))

/** Every check is a span in the `maple-uptime` service. */
export const UPTIME_SERVICE = "maple-uptime"

export const uptimeTracesHref = (): string =>
	hrefOf(AppRoute.Traces({ search: { services: [UPTIME_SERVICE] } }))

export const traceHref = (traceId: string): string => hrefOf(AppRoute.Trace({ traceId, search: {} }))
