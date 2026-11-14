import type { SupabaseIntegrationStatus } from "@maple/domain/http"
import type { SupabaseProjectRef } from "@maple/primitives"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import { resolveWindow } from "../../../../data/time-range"
import { HubRequest, type ProviderEnv, type ProviderReturn } from "../../../integrations/provider"
import {
	LoadSupabaseMetrics,
	ReadSupabaseClock,
	SetSupabaseSwitch,
	type SupabaseCardModel,
	SupabaseMessage,
	type SupabaseSwitchKind,
	SyncSupabase,
} from "./supabase"

type Env = ProviderEnv<SupabaseIntegrationStatus>
type Return = ProviderReturn<SupabaseCardModel, SupabaseMessage>

export const isSupabaseConnected = (env: Pick<Env, "status">): boolean =>
	Option.match(AsyncData.getData(env.status.data), {
		onNone: () => false,
		onSome: (status) => status.connected,
	})

/** The card's last-hour metrics rows, once the clock is read and the shown card is connected. */
export const requestMetricsRows = (model: SupabaseCardModel, env: Env, mode: Keyed.ReadMode): Return => {
	if (env.nowMs === 0 || !env.isShown || !isSupabaseConnected(env)) return { model }
	const window = resolveWindow({ preset: "1h", snap: true, timeZone: env.context.timeZone }, env.nowMs)
	const key = requestKey(env.context.orgId, "getSupabaseProjects", { data: window })
	return Option.match(Keyed.requestFor(model.metrics, key, mode), {
		onNone: () => ({ model }),
		onSome: (metrics) => ({
			model: { ...model, metrics },
			commands: [LoadSupabaseMetrics({ key: metrics.key, window })],
		}),
	})
}

export const clickedSync = (model: SupabaseCardModel): Return =>
	model.isSyncing ? { model } : { model: { ...model, isSyncing: true }, commands: [SyncSupabase()] }

/** A failed sync still re-reads the status: the card stays connected and shows its error. */
const completedSync = (model: SupabaseCardModel, failure: LoadFailure | null): Return => ({
	model: { ...model, isSyncing: false },
	requests: [
		HubRequest.readStatus("Supersede"),
		...(failure === null ? [] : [HubRequest.toast("error", "Couldn't sync Supabase", failure.message)]),
	],
})

/** One write per project at a time; a second flip while one saves is ignored. */
const toggledSwitch = (
	model: SupabaseCardModel,
	ref: SupabaseProjectRef,
	kind: SupabaseSwitchKind,
	enabled: boolean,
): Return =>
	Arr.some(model.pending, (entry) => entry.ref === ref)
		? { model }
		: {
				model: { ...model, pending: [...model.pending, { ref, kind, enabled, isSaved: false }] },
				commands: [SetSupabaseSwitch[kind]({ ref, enabled })],
			}

/** The toast title when a switch's write fails, by whether it turned the switch on. */
const FAILED_TITLE = {
	metrics: { on: "Couldn't start collecting metrics", off: "Couldn't stop collecting metrics" },
	logs: { on: "Couldn't start collecting logs", off: "Couldn't stop collecting logs" },
	drain: { on: "Couldn't create the log drain", off: "Couldn't remove the log drain" },
} as const satisfies Record<SupabaseSwitchKind, { readonly on: string; readonly off: string }>

const completedSwitch = (
	model: SupabaseCardModel,
	ref: SupabaseProjectRef,
	kind: SupabaseSwitchKind,
	enabled: boolean,
	failure: LoadFailure | null,
): Return => {
	// A failed write reverts the switch to the server's value.
	if (failure !== null)
		return {
			model: { ...model, pending: Arr.filter(model.pending, (entry) => entry.ref !== ref) },
			requests: [
				HubRequest.toast(
					"error",
					enabled ? FAILED_TITLE[kind].on : FAILED_TITLE[kind].off,
					failure.message,
				),
			],
		}
	// The rows re-read waits on a fresh clock, so a card open for an hour reads the current window.
	return {
		model: {
			...model,
			pending: Arr.map(model.pending, (entry) =>
				entry.ref === ref ? { ...entry, isSaved: true } : entry,
			),
		},
		requests: [HubRequest.readStatus("Supersede")],
		commands: [ReadSupabaseClock()],
	}
}

/** The status read that answers a saved write carries its value, so the pending flip retires. */
export const settledStatus = (model: SupabaseCardModel): SupabaseCardModel => ({
	...model,
	pending: Arr.filter(model.pending, (entry) => !entry.isSaved),
})

/** A superseding rows read: the window may equal the last one, and that read predates the write. */
const completedReadClock = (model: SupabaseCardModel, env: Env, nowMs: number): Return => {
	const rows = requestMetricsRows(model, { ...env, nowMs }, "Supersede")
	return { ...rows, requests: [HubRequest.setClock(nowMs)] }
}

export const update = (model: SupabaseCardModel, message: SupabaseMessage, env: Env): Return =>
	SupabaseMessage.match<Return>(message, {
		ClickedSync: () => clickedSync(model),
		CompletedSync: ({ failure }) => completedSync(model, failure),
		// Advances the card's window and "Last data" ages; the fresh clock re-reads rows on a new key.
		TickedClock: () => ({ model, requests: [HubRequest.readClock()] }),
		CompletedReadClock: ({ nowMs }) => completedReadClock(model, env, nowMs),
		CompletedLoadMetrics: ({ key, result }) => ({
			model: { ...model, metrics: Keyed.accept(model.metrics, key, result) },
		}),
		ToggledSwitch: ({ ref, kind, enabled }) => toggledSwitch(model, ref, kind, enabled),
		CompletedSwitch: ({ ref, kind, enabled, failure }) =>
			completedSwitch(model, ref, kind, enabled, failure),
	})
