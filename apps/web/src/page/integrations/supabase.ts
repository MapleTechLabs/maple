import { SupabaseProjectUpdateRequest } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../data/load-failure"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { Message } from "./message"

// The Supabase card: state and writes.

export const SupabaseCardModel = Schema.Struct({
	isSyncing: Schema.Boolean,
	/** Projects whose "Collect metrics" switch is saving. */
	pendingRefs: Schema.Array(SupabaseProjectRef),
})
export type SupabaseCardModel = typeof SupabaseCardModel.Type

export const initSupabaseCard = (): SupabaseCardModel => ({ isSyncing: false, pendingRefs: [] })

/** Supabase's lifecycle status as the row's pill reads it; `null` for a healthy project. */
export const projectStatusLabel = (
	status: string,
): Readonly<{ label: string; tone: "warn" | "crit" }> | null => {
	if (status === "ACTIVE_HEALTHY") return null
	if (status === "INACTIVE") return { label: "Paused", tone: "warn" }
	if (status === "ACTIVE_UNHEALTHY") return { label: "Unhealthy", tone: "crit" }
	return { label: sentenceCase(status), tone: status.endsWith("_FAILED") ? "crit" : "warn" }
}

/** `COMING_UP` reads "Coming up". */
const sentenceCase = (status: string): string => {
	const sentence = status
		.toLowerCase()
		.split("_")
		.filter((word) => word !== "")
		.join(" ")
	return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

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
