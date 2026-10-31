import { SupabaseProjectUpdateRequest } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { idle, KeyedSchema } from "../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { TimeWindow } from "../../data/time-range"
import { loadSupabaseProjects } from "../infra-integrations/supabase/data"
import { SupabaseProjectRow } from "../infra-integrations/supabase/model"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { Message } from "./message"

// The Supabase card: state and writes.

export const SupabaseSwitchKind = Schema.Literals(["metrics", "logs", "drain"])
export type SupabaseSwitchKind = typeof SupabaseSwitchKind.Type

/** A switch flip the server has not confirmed: shown in place of the status until the re-read lands. */
export const PendingSupabaseSwitch = Schema.Struct({
	ref: SupabaseProjectRef,
	kind: SupabaseSwitchKind,
	enabled: Schema.Boolean,
	/** The write succeeded; the entry waits for the status re-read that carries it. */
	isSaved: Schema.Boolean,
})
export type PendingSupabaseSwitch = typeof PendingSupabaseSwitch.Type

export const SupabaseCardModel = Schema.Struct({
	isSyncing: Schema.Boolean,
	/** At most one per project: a project's switches lock while its write and re-read are in flight. */
	pending: Schema.Array(PendingSupabaseSwitch),
	/** The last hour's metrics rows, for each project's health and "Last data". */
	metrics: KeyedSchema(Schema.Array(SupabaseProjectRow), LoadFailure),
})
export type SupabaseCardModel = typeof SupabaseCardModel.Type

export const initSupabaseCard = (): SupabaseCardModel => ({
	isSyncing: false,
	pending: [],
	metrics: idle(),
})

export const LoadSupabaseMetrics = Command.define("LoadIntegrationsSupabaseMetrics", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedLoadSupabaseMetrics],
	execute: ({ key, window }) =>
		Effect.map(loadSupabaseProjects(window), (result) =>
			Message.CompletedLoadSupabaseMetrics({ key, result }),
		),
})

/** After a switch settles, so the rows re-read resolves its window against now, not page mount. */
export const ReadSupabaseClock = Command.define("ReadSupabaseClock", {
	messages: [Message.CompletedReadSupabaseClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadSupabaseClock({ nowMs })),
})

export const SyncSupabase = Command.define("SyncSupabase", {
	messages: [Message.CompletedSupabaseSync],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		yield* client.integrations.supabaseSync()
	}).pipe(
		Effect.match({
			onFailure: (error) => Message.CompletedSupabaseSync({ failure: toLoadFailure(error) }),
			onSuccess: () => Message.CompletedSupabaseSync({ failure: null }),
		}),
	),
})

export const SetSupabaseMetrics = Command.define("SetSupabaseProjectMetrics", {
	args: { ref: SupabaseProjectRef, enabled: Schema.Boolean },
	messages: [Message.CompletedSupabaseMetrics],
	execute: ({ ref, enabled }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			yield* client.integrations.supabaseUpdateProject({
				params: { ref },
				payload: new SupabaseProjectUpdateRequest({ metricsEnabled: enabled }),
			})
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedSupabaseMetrics({ ref, enabled, failure: toLoadFailure(error) }),
				onSuccess: () => Message.CompletedSupabaseMetrics({ ref, enabled, failure: null }),
			}),
		),
})

export const SetSupabaseLogs = Command.define("SetSupabaseProjectLogs", {
	args: { ref: SupabaseProjectRef, enabled: Schema.Boolean },
	messages: [Message.CompletedSupabaseLogs],
	execute: ({ ref, enabled }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			yield* client.integrations.supabaseUpdateProject({
				params: { ref },
				payload: new SupabaseProjectUpdateRequest({ logsEnabled: enabled }),
			})
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedSupabaseLogs({ ref, enabled, failure: toLoadFailure(error) }),
				onSuccess: () => Message.CompletedSupabaseLogs({ ref, enabled, failure: null }),
			}),
		),
})

export const SetSupabaseLogDrain = Command.define("SetSupabaseProjectLogDrain", {
	args: { ref: SupabaseProjectRef, enabled: Schema.Boolean },
	messages: [Message.CompletedSupabaseLogDrain],
	execute: ({ ref, enabled }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			yield* client.integrations.supabaseUpdateProject({
				params: { ref },
				payload: new SupabaseProjectUpdateRequest({ logDrainEnabled: enabled }),
			})
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedSupabaseLogDrain({ ref, enabled, failure: toLoadFailure(error) }),
				onSuccess: () => Message.CompletedSupabaseLogDrain({ ref, enabled, failure: null }),
			}),
		),
})
