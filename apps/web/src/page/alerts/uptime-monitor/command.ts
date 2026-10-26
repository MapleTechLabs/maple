import { UptimeMonitorId } from "@maple/domain"
import { V2UptimeMonitorConfig } from "@maple/domain/http/v2"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { readIsAdmin } from "../shared/commands"
import { retrieveMonitor, setMonitorEnabled, testMonitorConfig } from "../shared/uptime-commands"
import { Message } from "./message"

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
