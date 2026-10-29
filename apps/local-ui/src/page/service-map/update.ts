import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import { Option, Result } from "effect"
import { AsyncData, Update } from "foldkit"
import { accept, acceptCached, idle } from "../../data/slot"
import { type PageContext, PageOutMessage, withParams } from "../contract"
import { ReadClock, ReadRefreshClock, ReadStored } from "./command"
import { MapBinding, ServiceMapPageComposition } from "./composition"
import { ServiceMapPageDefinition } from "./definition"
import { load } from "./load"
import type { Model } from "./model"
import { presenceAskOf, syncMapStep } from "./update-map"

const { makeStep, makeNoopStep } = ServiceMapPageDefinition

/** The map and the guide's copy buttons are assembled by their Bindings. */
export const init = ServiceMapPageComposition.makeInit((_context: PageContext) => ({
	model: {
		_tag: "ServiceMapPage",
		maybeAnchorMs: Option.none(),
		nowMs: 0,
		data: idle(),
		dataUpdatedAtMs: 0,
		maybeStored: Option.none(),
		maybeMap: Option.none(),
		isRefreshing: false,
	},
	commands: [ReadClock(), ReadStored()],
}))

/** `setRange`: remember it for pages opened without one, then put it in the hash. */
const setRange = (model: Model, context: PageContext, range: string) => ({
	model,
	outMessage: PageOutMessage.RememberedRange({ range, hash: withParams(context.location, { range }) }),
})

/** The refresh spinner stops once the refetch it started has settled. */
const settleRefresh = (model: Model): Model =>
	model.isRefreshing && !AsyncData.isLoading(model.data.data) && !AsyncData.isRefreshing(model.data.data)
		? { ...model, isRefreshing: false }
		: model

/** The page after a local transition, as the first Step before the map follows its rows. */
const pageStep = (next: Model) => makeStep(() => ({ model: next }))

export const update = ServiceMapPageComposition.makeUpdate.withContext((context: PageContext) => ({
	CompletedReadClock: (model, { nowMs }) =>
		load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
	CompletedReadStored: (model, { stored }) => {
		const next = { ...model, maybeStored: Option.some(stored) }
		return Update.withOutMessage(
			Update.combineSteps(model, [pageStep(next), syncMapStep(context)]),
			presenceAskOf(next, context),
		)
	},
	SucceededFetchServiceMap: (model, { key, data, fetchedAtMs }) => {
		if (model.data.key !== key) return makeNoopStep()(model)
		const next = settleRefresh({
			...model,
			data: accept(model.data, key, Result.succeed(data), fetchedAtMs),
			dataUpdatedAtMs: fetchedAtMs,
		})
		return Update.withOutMessage(
			Update.combineSteps(model, [pageStep(next), syncMapStep(context)]),
			presenceAskOf(next, context),
		)
	},
	FoundCachedServiceMap: (model, { key, cached }) => {
		if (model.data.key !== key) return makeNoopStep()(model)
		const next = {
			...model,
			data: acceptCached(model.data, key, cached, cached.isFresh),
			dataUpdatedAtMs: cached.updatedAtMs,
		}
		if (cached.isFresh)
			return Update.withOutMessage(
				Update.combineSteps(model, [pageStep(settleRefresh(next)), syncMapStep(context)]),
				presenceAskOf(next, context),
			)
		// Shown while the window's own rows load (an older window, or a stale exact one).
		return Update.withOutMessage(
			Update.combineSteps(model, [
				pageStep(next),
				syncMapStep(context),
				makeStep((shown: Model) => load(shown, context, true)),
			]),
			presenceAskOf(next, context),
		)
	},
	FailedFetchServiceMap: (model, { key, failure }) => ({
		model: settleRefresh({ ...model, data: accept(model.data, key, Result.fail(failure)) }),
	}),
	ClickedRefresh: (model) =>
		model.isRefreshing
			? { model }
			: { model: { ...model, isRefreshing: true }, commands: [ReadRefreshClock()] },
	CompletedReadRefreshClock: (model, { nowMs }) => {
		const next = snapToMinute(nowMs)
		// `advance()`: a new minute re-anchors the window (a new key); else refetch in place.
		if (Option.getOrNull(model.maybeAnchorMs) !== next)
			return load({ ...model, nowMs, maybeAnchorMs: Option.some(next), isRefreshing: false }, context)
		const refetch = load({ ...model, nowMs }, context, true)
		return {
			model: settleRefresh(refetch.model),
			commands: refetch.commands,
			outMessage: PageOutMessage.RefetchedInPlace(),
		}
	},
	ClickedRetry: (model) => load(model, context, true),
	ChangedRange: (model, { range }) => setRange(model, context, range),
	ClickedWidenRange: (model) => setRange(model, context, WIDEST_RANGE),
	CompletedSaveLayout: (model) => ({ model }),
	CompletedSaveViewPrefs: (model) => ({ model }),
	ClickedCloseDetail: (model) => MapBinding.requestCloseDetail()(model),
	ClickedFocusSelected: (model) => MapBinding.requestFocusSelected()(model),
	/** A new range re-keys the query; the map stays on the previous rows until the new ones land. */
	InformedOfLocationChange: (model) => load(model, context),
}))
