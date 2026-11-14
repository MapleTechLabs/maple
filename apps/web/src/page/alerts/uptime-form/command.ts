import { UptimeMonitorId } from "@maple/domain"
import { UptimeMonitorKind } from "@maple/primitives"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { readSupportedTimeZones } from "../../../platform/time-zone"
import { trackProduct } from "../../../data/analytics"
import { recentServiceNames } from "../shared/services"
import { retrieveMonitor, saveMonitor, testMonitorConfig } from "../../kit/uptime/commands"
import { Message } from "./message"
import { fetchSessionGrants } from "../../kit/session-grants"

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
	execute: Effect.map(recentServiceNames, (services) => Message.CompletedFetchServices({ services })),
})

export const ReadFormTimeZones = Command.define("ReadUptimeFormTimeZones", {
	messages: [Message.CompletedReadTimeZones],
	execute: Effect.map(readSupportedTimeZones, (zones) => Message.CompletedReadTimeZones({ zones })),
})

export const FetchFormSession = fetchSessionGrants("FetchUptimeFormSession", Message.CompletedFetchSession)

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

/** A created monitor is the `uptime_monitor_created` product event. */
export const TrackCreated = Command.define("TrackUptimeMonitorCreated", {
	args: { kind: UptimeMonitorKind },
	messages: [Message.CompletedTrackCreated],
	execute: ({ kind }) =>
		trackProduct("uptime_monitor_created", { kind }).pipe(Effect.as(Message.CompletedTrackCreated())),
})
