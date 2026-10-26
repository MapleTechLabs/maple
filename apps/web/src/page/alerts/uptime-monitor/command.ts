import { UptimeMonitorId } from "@maple/domain"
import { V2UptimeMonitorConfig } from "@maple/domain/http/v2"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { getUptimeCheckStats } from "@maple/web-data/warehouse/uptime"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { readIsAdmin } from "../shared/commands"
import { retrieveMonitor, setMonitorEnabled, testMonitorConfig } from "../shared/uptime-commands"
import { Message } from "./message"
import { UptimeWindow } from "./model"

export const ReadMonitorClock = Command.define("ReadUptimeMonitorClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const FetchMonitorSession = Command.define("FetchUptimeMonitorSession", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedFetchSession],
	execute: ({ orgId }) =>
		Effect.map(readIsAdmin, (isAdmin) => Message.CompletedFetchSession({ orgId, isAdmin })),
})

export const FetchMonitor = Command.define("FetchUptimeMonitor", {
	args: { key: Schema.String, monitorId: UptimeMonitorId },
	messages: [Message.CompletedFetchMonitor],
	execute: ({ key, monitorId }) =>
		retrieveMonitor(monitorId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchMonitor({ key, result })),
		),
})

export const ToggleMonitorEnabled = Command.define("ToggleUptimeMonitorEnabled", {
	args: { monitorId: UptimeMonitorId, enabled: Schema.Boolean },
	messages: [Message.CompletedToggle],
	execute: ({ monitorId, enabled }) =>
		setMonitorEnabled(monitorId, enabled).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedToggle({ result })),
		),
})

/** "Check now": one HTTP check with the saved config, nothing stored. */
export const CheckMonitorNow = Command.define("CheckUptimeMonitorNow", {
	args: { config: V2UptimeMonitorConfig },
	messages: [Message.CompletedCheckNow],
	execute: ({ config }) =>
		testMonitorConfig({ config }).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedCheckNow({ result })),
		),
})

const WINDOW_MS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 } as const

/** The monitor's checks over the window, read from its check spans. */
export const FetchCheckStats = Command.define("FetchUptimeCheckStats", {
	args: { key: Schema.String, monitorId: UptimeMonitorId, window: UptimeWindow },
	messages: [Message.CompletedFetchStats],
	execute: ({ key, monitorId, window }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			return yield* getUptimeCheckStats({
				monitorId,
				startTime: formatWarehouseDateTime(nowMs - WINDOW_MS[window]),
				endTime: formatWarehouseDateTime(nowMs),
			}).pipe(Effect.map((stats) => ({ ...stats, window })))
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchStats({ key, result })),
		),
})
