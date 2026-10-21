import type { SupabaseProjectRef } from "@maple/domain/primitives"
import { Option, type Result } from "effect"
import { AsyncData } from "foldkit"
import * as Keyed from "../../data/keyed"
import type { LoadFailure } from "../../data/load-failure"
import { requestKey } from "../../data/request-key"
import { resolveWindow } from "../../data/time-range"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import type { SupabaseProjectRow } from "../infra-integrations/supabase/model"
import { integrationOfSearch } from "./catalog"
import type { Message } from "./message"
import type { Model } from "./model"
import {
	LoadSupabaseMetrics,
	ReadSupabaseClock,
	SetSupabaseLogs,
	SetSupabaseMetrics,
	type SupabaseCardModel,
	SyncSupabase,
} from "./supabase"
import { requestStatus } from "./update-status"

// The Supabase card's state changes.

type Return = PageReturn<Model, Message>

const withCard = (model: Model, card: Partial<SupabaseCardModel>): Model => ({
	...model,
	supabaseCard: { ...model.supabaseCard, ...card },
})

const toast = (model: Model, type: "success" | "error", title: string, description = ""): Return => ({
	model,
	outMessage: PageOutMessage.RequestedToast({ type, title, description }),
})

const isConnected = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.statuses.supabase.data), {
		onNone: () => false,
		onSome: (status) => status.connected,
	})

/** The card's last-hour metrics rows, once the clock is read and the shown card is connected. */
export const requestMetricsRows = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	if (
		model.nowMs === 0 ||
		integrationOfSearch(model.search.integration) !== "supabase" ||
		!isConnected(model)
	)
		return { model }
	const window = resolveWindow({ preset: "1h", snap: true, timeZone: context.timeZone }, model.nowMs)
	const key = requestKey(context.orgId, "getSupabaseProjects", { data: window })
	return Option.match(Keyed.requestFor(model.supabaseCard.metrics, key, mode), {
		onNone: () => ({ model }),
		onSome: (metrics) => ({
			model: withCard(model, { metrics }),
			commands: [LoadSupabaseMetrics({ key: metrics.key, window })],
		}),
	})
}

export const completedMetricsRows = (
	model: Model,
	key: string,
	result: Result.Result<ReadonlyArray<SupabaseProjectRow>, LoadFailure>,
): Return => ({ model: withCard(model, { metrics: Keyed.accept(model.supabaseCard.metrics, key, result) }) })

export const clickedSync = (model: Model): Return =>
	model.supabaseCard.isSyncing
		? { model }
		: { model: withCard(model, { isSyncing: true }), commands: [SyncSupabase()] }

export const completedSync = (model: Model, context: PageContext, failure: LoadFailure | null): Return => {
	const settled = withCard(model, { isSyncing: false })
	const reloaded = requestStatus(settled, context, "supabase", "Supersede")
	// A failed sync still re-reads the status: the card stays connected and shows its error.
	return failure === null
		? reloaded
		: { ...reloaded, ...toast(reloaded.model, "error", "Failed to sync Supabase", failure.message) }
}

/** One write per project at a time; a second flip while one saves is ignored. */
const toggled = (
	model: Model,
	ref: SupabaseProjectRef,
	command: ReturnType<typeof SetSupabaseMetrics | typeof SetSupabaseLogs>,
): Return =>
	model.supabaseCard.pendingRefs.includes(ref)
		? { model }
		: {
				model: withCard(model, { pendingRefs: [...model.supabaseCard.pendingRefs, ref] }),
				commands: [command],
			}

const completed = (
	model: Model,
	context: PageContext,
	ref: SupabaseProjectRef,
	failure: LoadFailure | null,
	failedTitle: string,
): Return => {
	const settled = withCard(model, {
		pendingRefs: model.supabaseCard.pendingRefs.filter((pending) => pending !== ref),
	})
	if (failure !== null) return toast(settled, "error", failedTitle, failure.message)
	// The rows re-read waits on a fresh clock, so a card open for an hour reads the current window.
	const reread = requestStatus(settled, context, "supabase", "Supersede")
	return { ...reread, commands: [...(reread.commands ?? []), ReadSupabaseClock()] }
}

/** A superseding rows read: the window may equal the last one, and that read predates the write. */
export const completedReadClock = (model: Model, context: PageContext, nowMs: number): Return =>
	requestMetricsRows({ ...model, nowMs }, context, "Supersede")

export const toggledMetrics = (model: Model, ref: SupabaseProjectRef, enabled: boolean): Return =>
	toggled(model, ref, SetSupabaseMetrics({ ref, enabled }))

export const completedMetrics = (
	model: Model,
	context: PageContext,
	ref: SupabaseProjectRef,
	enabled: boolean,
	failure: LoadFailure | null,
): Return =>
	completed(
		model,
		context,
		ref,
		failure,
		enabled ? "Failed to start collecting metrics" : "Failed to stop collecting metrics",
	)

export const toggledLogs = (model: Model, ref: SupabaseProjectRef, enabled: boolean): Return =>
	toggled(model, ref, SetSupabaseLogs({ ref, enabled }))

export const completedLogs = (
	model: Model,
	context: PageContext,
	ref: SupabaseProjectRef,
	enabled: boolean,
	failure: LoadFailure | null,
): Return =>
	completed(
		model,
		context,
		ref,
		failure,
		enabled ? "Failed to start collecting logs" : "Failed to stop collecting logs",
	)
