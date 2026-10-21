import type { SupabaseProjectRef } from "@maple/domain/primitives"
import type { LoadFailure } from "../../data/load-failure"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import type { Message } from "./message"
import type { Model } from "./model"
import { SetSupabaseMetrics, type SupabaseCardModel, SyncSupabase } from "./supabase"
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
export const toggledMetrics = (model: Model, ref: SupabaseProjectRef, enabled: boolean): Return =>
	model.supabaseCard.pendingRefs.includes(ref)
		? { model }
		: {
				model: withCard(model, { pendingRefs: [...model.supabaseCard.pendingRefs, ref] }),
				commands: [SetSupabaseMetrics({ ref, enabled })],
			}

export const completedMetrics = (
	model: Model,
	context: PageContext,
	ref: SupabaseProjectRef,
	enabled: boolean,
	failure: LoadFailure | null,
): Return => {
	const settled = withCard(model, {
		pendingRefs: model.supabaseCard.pendingRefs.filter((pending) => pending !== ref),
	})
	return failure === null
		? requestStatus(settled, context, "supabase", "Supersede")
		: toast(
				settled,
				"error",
				enabled ? "Failed to start collecting metrics" : "Failed to stop collecting metrics",
				failure.message,
			)
}
