import { readClock } from "@maple/views/data/timing"
import { SupabaseProjectUpdateRequest } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { idle, KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure, toLoadFailure } from "@maple/views/data/load-failure"
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
export const ReadSupabaseClock = readClock("ReadSupabaseClock", Message.CompletedReadSupabaseClock)

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

type SwitchDone = Schema.Top &
	((fields: {
		readonly ref: SupabaseProjectRef
		readonly enabled: boolean
		readonly failure: LoadFailure | null
	}) => Message)

/** A project switch's write: one field of the project update, answered by its own Message. */
const setSwitch = <const Name extends string>(
	name: Name,
	field: "metricsEnabled" | "logsEnabled" | "logDrainEnabled",
	done: SwitchDone,
) =>
	Command.define(name, {
		args: { ref: SupabaseProjectRef, enabled: Schema.Boolean },
		messages: [done],
		execute: ({ ref, enabled }) =>
			Effect.gen(function* () {
				const client = yield* MapleInternalApiClient
				yield* client.integrations.supabaseUpdateProject({
					params: { ref },
					payload: new SupabaseProjectUpdateRequest({ [field]: enabled }),
				})
			}).pipe(
				Effect.match({
					onFailure: (error) => done({ ref, enabled, failure: toLoadFailure(error) }),
					onSuccess: () => done({ ref, enabled, failure: null }),
				}),
			),
	})

/** Each project switch's write. */
export const SetSupabaseSwitch = {
	metrics: setSwitch("SetSupabaseProjectMetrics", "metricsEnabled", Message.CompletedSupabaseMetrics),
	logs: setSwitch("SetSupabaseProjectLogs", "logsEnabled", Message.CompletedSupabaseLogs),
	drain: setSwitch("SetSupabaseProjectLogDrain", "logDrainEnabled", Message.CompletedSupabaseLogDrain),
} satisfies { readonly [K in SupabaseSwitchKind]: unknown }
