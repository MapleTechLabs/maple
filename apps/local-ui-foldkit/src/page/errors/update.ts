import type { Resources } from "../../platform/resources"
import { snapToMinute, WIDEST_RANGE } from "@maple/local-ui/lib/time"
import * as FilterSections from "@maple/web-foldkit/ui/filters/filter-sections"
import { Option, Record, Result } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import { accept, idle } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage, replaceParams, withParams } from "../contract"
import { updateCopy } from "../kit/copies"
import { ReadClock, ReadRefreshClock } from "./command"
import type { ErrorTrace, ErrorTypeRow } from "./fetch"
import type { LoadFailure } from "../../data/local-query"
import { cardOf, load, loadCard } from "./load"
import { Message } from "./message"
import type { Model } from "./model"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, PageOutMessage, Resources>

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

export const init = (
	_context: PageContext,
): Readonly<{ model: Model; commands: ReadonlyArray<Command.Command<Message, never, Resources>> }> => ({
	model: {
		_tag: "ErrorsPage",
		maybeAnchorMs: Option.none(),
		nowMs: 0,
		summary: idle(),
		byType: idle(),
		byTypeUpdatedAtMs: 0,
		facets: idle(),
		cards: {},
		sections: FilterSections.init(),
		isRefreshing: false,
		copies: {},
	},
	commands: [ReadClock(), Command.mapMessage(FilterSections.ReadRemembered(), toSections)],
})

export const locationChanged = (model: Model, context: PageContext): UpdateReturn => load(model, context)

const navigate = (model: Model, context: PageContext, updates: Record<string, string | null>): UpdateReturn => ({
	model,
	outMessage: replaceParams(context.location, updates),
})

const setRange = (model: Model, context: PageContext, range: string): UpdateReturn => ({
	model,
	outMessage: PageOutMessage.RememberedRange({ range, hash: withParams(context.location, { range }) }),
})

const settleRefresh = (model: Model): Model => {
	const isLoading = (data: AsyncData.AsyncData<unknown, unknown>) =>
		AsyncData.isLoading(data) || AsyncData.isRefreshing(data)
	const slots = [model.summary.data, model.byType.data, model.facets.data, ...Object.values(model.cards).map((card) => card.traces.data)]
	return model.isRefreshing && !slots.some(isLoading) ? { ...model, isRefreshing: false } : model
}

/** Cards are keyed by fingerprint: a type no longer listed unmounts, and its state goes with it. */
const pruneCards = (model: Model, rows: ReadonlyArray<ErrorTypeRow>): Model => {
	const listed = new Set(rows.map((row) => row.fingerprintHash))
	return { ...model, cards: Record.filter(model.cards, (_, fingerprintHash) => listed.has(fingerprintHash)) }
}

/** `ErrorTypeCard`'s toggle: opening it asks for its traces (a held answer is reused). */
const toggleCard = (model: Model, context: PageContext, fingerprintHash: string): UpdateReturn => {
	const card = cardOf(model, fingerprintHash)
	const next = { ...model, cards: Record.set(model.cards, fingerprintHash, { ...card, isExpanded: !card.isExpanded }) }
	return loadCard(next, context, fingerprintHash)
}

const settleTraces = (
	model: Model,
	fingerprintHash: string,
	key: string,
	result: Result.Result<ReadonlyArray<ErrorTrace>, LoadFailure>,
): Model => {
	const card = cardOf(model, fingerprintHash)
	return Record.has(model.cards, fingerprintHash)
		? settleRefresh({ ...model, cards: Record.set(model.cards, fingerprintHash, { ...card, traces: accept(card.traces, key, result) }) })
		: model
}

export const update = (model: Model, message: Message, context: PageContext): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		CompletedReadClock: ({ nowMs }) => {
			const loaded = load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context)
			// `ErrorsView` reads `useSignalPresence("traces")` on mount, empty or not.
			return { ...loaded, outMessage: PageOutMessage.RequestedSignalPresence() }
		},
		SucceededFetchSummary: ({ key, summary }) =>
			({ model: settleRefresh({ ...model, summary: accept(model.summary, key, Result.succeed(summary)) }) }),
		FailedFetchSummary: ({ key, failure }) =>
			({ model: settleRefresh({ ...model, summary: accept(model.summary, key, Result.fail(failure)) }) }),
		SucceededFetchByType: ({ key, rows, fetchedAtMs }) => {
			if (model.byType.key !== key) return { model }
			const next = { ...model, byType: accept(model.byType, key, Result.succeed(rows)), byTypeUpdatedAtMs: fetchedAtMs }
			return { model: settleRefresh(pruneCards(next, rows)) }
		},
		FailedFetchByType: ({ key, failure }) => {
			const byType = accept(model.byType, key, Result.fail(failure))
			// The error state replaces the list, unmounting every card.
			const cards = AsyncData.isFailure(byType.data) ? {} : model.cards
			return { model: settleRefresh({ ...model, byType, cards }) }
		},
		SucceededFetchFacets: ({ key, facets }) =>
			({ model: settleRefresh({ ...model, facets: accept(model.facets, key, Result.succeed(facets)) }) }),
		FailedFetchFacets: ({ key, failure }) =>
			({ model: settleRefresh({ ...model, facets: accept(model.facets, key, Result.fail(failure)) }) }),
		ClickedErrorType: ({ fingerprintHash }) => toggleCard(model, context, fingerprintHash),
		SucceededFetchTraces: ({ fingerprintHash, key, traces }) =>
			({ model: settleTraces(model, fingerprintHash, key, Result.succeed(traces)) }),
		FailedFetchTraces: ({ fingerprintHash, key, failure }) =>
			({ model: settleTraces(model, fingerprintHash, key, Result.fail(failure)) }),
		ClickedRetryTraces: ({ fingerprintHash }) => loadCard(model, context, fingerprintHash, true),
		ClickedRefresh: () =>
			model.isRefreshing ? { model } : { model: { ...model, isRefreshing: true }, commands: [ReadRefreshClock()] },
		CompletedReadRefreshClock: ({ nowMs }) => {
			const next = snapToMinute(nowMs)
			// `advance()`: a new minute re-anchors the window (new keys); else refetch in place.
			if (Option.getOrNull(model.maybeAnchorMs) !== next)
				return load({ ...model, nowMs, maybeAnchorMs: Option.some(next), isRefreshing: false }, context)
			const refetch = load({ ...model, nowMs }, context, true)
			return { model: settleRefresh(refetch.model), commands: refetch.commands, outMessage: PageOutMessage.RefetchedInPlace() }
		},
		ToggledRootOnly: () =>
			navigate(model, context, { root: queryOf(context.location).get("root") === "1" ? null : "1" }),
		ToggledFacetOption: ({ param, name }) =>
			navigate(model, context, { [param]: queryOf(context.location).get(param) === name ? null : name }),
		ClickedClearFilters: () => navigate(model, context, { service: null, env: null, root: null }),
		ChangedRange: ({ range }) => setRange(model, context, range),
		ClickedWidenRange: () => setRange(model, context, WIDEST_RANGE),
		GotFilterSectionsMessage: ({ message: child }) => {
			const next = FilterSections.update(model.sections, child)
			return { model: { ...model, sections: next.model }, commands: Command.mapMessages(next.commands ?? [], toSections) }
		},
		GotCopyMessage: ({ id, message: child }) => {
			const next = updateCopy(model.copies, id, child, (copyId, copyMessage) => Message.GotCopyMessage({ id: copyId, message: copyMessage }))
			return { model: { ...model, copies: next.copies }, commands: next.commands }
		},
	})
