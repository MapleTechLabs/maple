import type { Resources } from "../../platform/resources"
import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import * as ServiceMap from "@maple/web/service-map/map/service-map"
import { Option, Result } from "effect"
import { AsyncData, type Command } from "foldkit"
import { accept, acceptCached, idle } from "../../data/slot"
import { type PageContext, PageOutMessage, withParams } from "../contract"
import { updateCopy } from "../kit/copies"
import { ReadClock, ReadRefreshClock, ReadStored } from "./command"
import { load } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { syncMap, type UpdateReturn, withMapStep } from "./update-map"

export type { UpdateReturn } from "./update-map"

export const init = (
	_context: PageContext,
): Readonly<{ model: Model; commands: ReadonlyArray<Command.Command<Message, never, Resources>> }> => ({
	model: {
		_tag: "ServiceMapPage",
		maybeAnchorMs: Option.none(),
		nowMs: 0,
		data: idle(),
		dataUpdatedAtMs: 0,
		maybeStored: Option.none(),
		maybeMap: Option.none(),
		isRefreshing: false,
		copies: {},
	},
	commands: [ReadClock(), ReadStored()],
})

/** A new range re-keys the query; the map stays on the previous rows until the new ones land. */
export const locationChanged = (model: Model, context: PageContext): UpdateReturn => load(model, context)

/** `setRange`: remember it for pages opened without one, then put it in the hash. */
const setRange = (model: Model, context: PageContext, range: string): UpdateReturn => ({
	model,
	outMessage: PageOutMessage.RememberedRange({ range, hash: withParams(context.location, { range }) }),
})

/** The refresh spinner stops once the refetch it started has settled. */
const settleRefresh = (model: Model): Model =>
	model.isRefreshing && !AsyncData.isLoading(model.data.data) && !AsyncData.isRefreshing(model.data.data)
		? { ...model, isRefreshing: false }
		: model

export const update = (model: Model, message: Message, context: PageContext): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		CompletedReadClock: ({ nowMs }) =>
			load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
		CompletedReadStored: ({ stored }) =>
			syncMap({ model: { ...model, maybeStored: Option.some(stored) } }, context),
		SucceededFetchServiceMap: ({ key, data, fetchedAtMs }) => {
			if (model.data.key !== key) return { model }
			const next = {
				...model,
				data: accept(model.data, key, Result.succeed(data), fetchedAtMs),
				dataUpdatedAtMs: fetchedAtMs,
			}
			return syncMap({ model: settleRefresh(next) }, context)
		},
		FoundCachedServiceMap: ({ key, cached }) => {
			if (model.data.key !== key) return { model }
			const next = {
				...model,
				data: acceptCached(model.data, key, cached, cached.isFresh),
				dataUpdatedAtMs: cached.updatedAtMs,
			}
			const shown = syncMap({ model: cached.isFresh ? settleRefresh(next) : next }, context)
			if (cached.isFresh) return shown
			// Shown while the window's own rows load (an older window, or a stale exact one).
			const again = load(shown.model, context, true)
			return {
				...shown,
				model: again.model,
				commands: [...(shown.commands ?? []), ...(again.commands ?? [])],
			}
		},
		FailedFetchServiceMap: ({ key, failure }) => ({
			model: settleRefresh({ ...model, data: accept(model.data, key, Result.fail(failure)) }),
		}),
		ClickedRefresh: () =>
			model.isRefreshing
				? { model }
				: { model: { ...model, isRefreshing: true }, commands: [ReadRefreshClock()] },
		CompletedReadRefreshClock: ({ nowMs }) => {
			const next = snapToMinute(nowMs)
			// `advance()`: a new minute re-anchors the window (a new key); else refetch in place.
			if (Option.getOrNull(model.maybeAnchorMs) !== next)
				return load(
					{ ...model, nowMs, maybeAnchorMs: Option.some(next), isRefreshing: false },
					context,
				)
			const refetch = load({ ...model, nowMs }, context, true)
			return {
				model: settleRefresh(refetch.model),
				commands: refetch.commands,
				outMessage: PageOutMessage.RefetchedInPlace(),
			}
		},
		ClickedRetry: () => load(model, context, true),
		ChangedRange: ({ range }) => setRange(model, context, range),
		ClickedWidenRange: () => setRange(model, context, WIDEST_RANGE),
		CompletedSaveLayout: () => ({ model }),
		CompletedSaveViewPrefs: () => ({ model }),
		GotMapMessage: ({ message: child }) =>
			Option.match(model.maybeMap, {
				onNone: () => ({ model }),
				onSome: (map) => withMapStep(model, ServiceMap.update(map, child)),
			}),
		GotCopyMessage: ({ id, message: child }) => {
			const next = updateCopy(model.copies, id, child, (copyId, copyMessage) =>
				Message.GotCopyMessage({ id: copyId, message: copyMessage }),
			)
			return { model: { ...model, copies: next.copies }, commands: next.commands }
		},
	})
