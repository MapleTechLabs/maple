import { UptimeMonitorId } from "@maple/domain"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { readSupportedTimeZones } from "../../../platform/time-zone"
import { readGrants } from "../../../data/session-tenant"
import { recentServiceNames } from "../shared/services"
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
	execute: Effect.map(recentServiceNames, (services) => Message.CompletedFetchServices({ services })),
})

export const ReadFormTimeZones = Command.define("ReadUptimeFormTimeZones", {
	messages: [Message.CompletedReadTimeZones],
	execute: Effect.map(readSupportedTimeZones, (zones) => Message.CompletedReadTimeZones({ zones })),
})

export const FetchFormSession = Command.define("FetchUptimeFormSession", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedFetchSession],
	execute: ({ orgId }) =>
		Effect.map(readGrants, (grants) => Message.CompletedFetchSession({ orgId, grants })),
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
