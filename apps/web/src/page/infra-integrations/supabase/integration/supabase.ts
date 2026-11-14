import { readClock } from "@maple/views/data/timing"
import { SupabaseProjectUpdateRequest } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/primitives"
import { Effect, Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { Command } from "foldkit"
import { idle, KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure, toLoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { loadSupabaseProjects } from "../data"
import { SupabaseProjectRow } from "../model"
import { IntegrationStatuses } from "../../../../data/integration-statuses"
import { MapleInternalApiClient } from "../../../../platform/api-clients"

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

/** The Supabase module's own messages; the hub carries them in `GotSupabaseMessage`. */
export const SupabaseMessage = defineMessageUnion({
	ClickedSync: {},
	CompletedSync: { failure: Schema.NullOr(LoadFailure) },
	/** Every minute while the connected card is shown, so its window and ages advance. */
	TickedClock: {},
	/** The clock read after a settled switch; its rows re-read supersedes on the fresh window. */
	CompletedReadClock: { nowMs: Schema.Number },
	CompletedLoadMetrics: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(SupabaseProjectRow), LoadFailure),
	},
	/** A project row's Metrics, Logs or Drain switch (a drain is created or deleted at Supabase). */
	ToggledSwitch: { ref: SupabaseProjectRef, kind: SupabaseSwitchKind, enabled: Schema.Boolean },
	CompletedSwitch: {
		ref: SupabaseProjectRef,
		kind: SupabaseSwitchKind,
		enabled: Schema.Boolean,
		failure: Schema.NullOr(LoadFailure),
	},
})
export type SupabaseMessage = typeof SupabaseMessage.Type

/** The hub's status read for Supabase, shared with the sidebar. */
export const SUPABASE_STATUS_READ = {
	name: "LoadIntegrationsSupabaseStatus",
	read: (refresh: boolean) =>
		Effect.flatMap(IntegrationStatuses, (statuses) => statuses.supabase({ refresh })),
}

export const LoadSupabaseMetrics = Command.define("LoadIntegrationsSupabaseMetrics", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [SupabaseMessage.CompletedLoadMetrics],
	execute: ({ key, window }) =>
		Effect.map(loadSupabaseProjects(window), (result) =>
			SupabaseMessage.CompletedLoadMetrics({ key, result }),
		),
})

/** After a switch settles, so the rows re-read resolves its window against now, not page load. */
export const ReadSupabaseClock = readClock("ReadSupabaseClock", SupabaseMessage.CompletedReadClock)

export const SyncSupabase = Command.define("SyncSupabase", {
	messages: [SupabaseMessage.CompletedSync],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		yield* client.integrations.supabaseSync()
	}).pipe(
		Effect.match({
			onFailure: (error) => SupabaseMessage.CompletedSync({ failure: toLoadFailure(error) }),
			onSuccess: () => SupabaseMessage.CompletedSync({ failure: null }),
		}),
	),
})

/** A project switch's write: one field of the project update. */
const setSwitch = <const Name extends string>(
	name: Name,
	kind: SupabaseSwitchKind,
	field: "metricsEnabled" | "logsEnabled" | "logDrainEnabled",
) =>
	Command.define(name, {
		args: { ref: SupabaseProjectRef, enabled: Schema.Boolean },
		messages: [SupabaseMessage.CompletedSwitch],
		execute: ({ ref, enabled }) =>
			Effect.gen(function* () {
				const client = yield* MapleInternalApiClient
				yield* client.integrations.supabaseUpdateProject({
					params: { ref },
					payload: new SupabaseProjectUpdateRequest({ [field]: enabled }),
				})
			}).pipe(
				Effect.match({
					onFailure: (error) =>
						SupabaseMessage.CompletedSwitch({
							ref,
							kind,
							enabled,
							failure: toLoadFailure(error),
						}),
					onSuccess: () => SupabaseMessage.CompletedSwitch({ ref, kind, enabled, failure: null }),
				}),
			),
	})

/** Each project switch's write. */
export const SetSupabaseSwitch = {
	metrics: setSwitch("SetSupabaseProjectMetrics", "metrics", "metricsEnabled"),
	logs: setSwitch("SetSupabaseProjectLogs", "logs", "logsEnabled"),
	drain: setSwitch("SetSupabaseProjectLogDrain", "drain", "logDrainEnabled"),
} satisfies { readonly [K in SupabaseSwitchKind]: unknown }
