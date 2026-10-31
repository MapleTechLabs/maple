import { UptimeMonitorId } from "@maple/domain"
import { getTracesFacets } from "@maple/web-data/warehouse/traces"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { currentWindow } from "../../../data/time-range"
import { readSupportedTimeZones } from "../../../platform/time-zone"
import { readIsAdmin } from "../shared/commands"
import { retrieveMonitor, saveMonitor, testMonitorConfig } from "../shared/uptime-commands"
import { Message } from "./message"

export const FetchExistingMonitor = Command.define("FetchUptimeFormMonitor", {
	args: { key: Schema.String, monitorId: UptimeMonitorId },
	messages: [Message.CompletedFetchExisting],
	execute: ({ key, monitorId }) =>
		retrieveMonitor(monitorId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchExisting({ key, result })),
		),
})

/** The traces facets of the last day: the services a monitor can belong to. Empty on failure. */
export const FetchFormServices = Command.define("FetchUptimeFormServices", {
	messages: [Message.CompletedFetchServices],
	execute: currentWindow({ preset: "24h", snap: true }).pipe(
		Effect.flatMap((window) => getTracesFacets({ data: window })),
		Effect.map((response) => response.data.services.map((row) => row.name)),
		Effect.orElseSucceed((): ReadonlyArray<string> => []),
		Effect.map((services) => Message.CompletedFetchServices({ services })),
	),
})

export const ReadFormTimeZones = Command.define("ReadUptimeFormTimeZones", {
	messages: [Message.CompletedReadTimeZones],
	execute: Effect.map(readSupportedTimeZones, (zones) => Message.CompletedReadTimeZones({ zones })),
})

export const FetchFormSession = Command.define("FetchUptimeFormSession", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedFetchSession],
	execute: ({ orgId }) =>
		Effect.map(readIsAdmin, (isAdmin) => Message.CompletedFetchSession({ orgId, isAdmin })),
})

/** The test endpoint with the draft's config; validation failures come back as the failure. */
export const TestDraft = Command.define("TestUptimeDraft", {
	args: { config: Schema.Unknown },
	messages: [Message.CompletedTest],
	execute: ({ config }) =>
		testMonitorConfig({ config }).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedTest({ result })),
		),
})

export const SaveDraft = Command.define("SaveUptimeDraft", {
	args: { editingId: Schema.NullOr(UptimeMonitorId), payload: Schema.Unknown },
	messages: [Message.CompletedSave],
	execute: ({ editingId, payload }) =>
		saveMonitor(editingId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ result })),
		),
})
