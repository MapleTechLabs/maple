import { PrReviewCategory, PrReviewFindingStatus, PrReviewSeverity } from "@maple/domain/http"
import { Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import { AppRoute, hrefOf } from "../../../route"
import type { CodeReviewIssuesSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import * as Tooltip from "../../../ui/tooltip"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { epochWindow } from "../kit/api"
import { ALL, type FrameOut, type FrameReturn } from "../kit/frame"
import {
	type Carried,
	frameRetained,
	frameRouteChanged,
	initFrame,
	noCarry,
	updateFrame,
} from "../kit/frame-update"
import type { Retained } from "../kit/retained"
import { cachedStep, mergeSteps, remember } from "../kit/page-steps"
import type { SheetOut } from "../kit/review-sheet"
import { initSheet, type SheetReturn, syncSheet, updateSheet } from "../kit/review-sheet-update"
import { draftQuery, syncedDraft } from "../kit/search"
import {
	FetchFindingAuthors,
	FetchFindings,
	type FilterKey,
	Message,
	type Model,
	WaitSearchDebounce,
} from "./model"

export type Search = typeof CodeReviewIssuesSearch.Type
type Return = PageReturn<Model, Message>

export const DEFAULT_PRESET = "30d"
export const PAGE = 50
export const MAX_ROWS = 200
const FRAME_ID = "code-review-issues"

const searchHref = (search: Search) => hrefOf(AppRoute.CodeReviewIssues({ search }))

const navigate = (model: Model, patch: Partial<Search>): Return => {
	const isFilter = Object.keys(patch).some((key) => key !== "review")
	return {
		model: isFilter ? { ...model, limit: PAGE } : model,
		outMessage: PageOutMessage.RequestedNavigation({
			url: searchHref({ ...model.search, ...patch }),
			isReplace: false,
		}),
	}
}

const request = (model: Model, context: PageContext, window: TimeWindow, mode: Keyed.RequestMode): Return => {
	const base = { ...epochWindow(window), repositoryId: model.search.repo }
	const query = {
		...base,
		author: model.search.author,
		severity: model.search.severity,
		category: model.search.category,
		status: model.search.state,
		q: model.search.q,
		limit: model.limit,
	}
	const authorsQuery = { ...base, author: undefined }
	const nowMs = model.frame.nowMs
	const step = mergeSteps<Model, Message>([
		cachedStep(
			model.findingsCache,
			nowMs,
			model.findings,
			requestKey(context.orgId, "codeReview.listFindings", { query }),
			mode,
			(findings) => ({ findings }),
			(key) => FetchFindings({ key, query }),
		),
		cachedStep(
			model.authorsCache,
			nowMs,
			model.authors,
			requestKey(context.orgId, "codeReview.analytics", { query: authorsQuery }),
			"Load",
			(authors) => ({ authors }),
			(key) => FetchFindingAuthors({ key, query: authorsQuery }),
		),
	])
	return { model: { ...model, ...step.patch }, commands: step.commands }
}

const applyOut = (model: Model, out: FrameOut, context: PageContext): Return => {
	switch (out._tag) {
		case "PickedRepository":
			return navigate(model, { repo: out.repo })
		case "PickedOption":
			return navigate(model, { author: out.value })
		case "PickedWindow":
			return navigate(model, out.window)
		case "RefusedWindow":
			return { model, outMessage: out.toast }
		case "ResolvedWindow":
			return request(
				{
					...model,
					sheet: { ...model.sheet, nowMs: Math.max(model.sheet.nowMs, model.frame.nowMs) },
				},
				context,
				out.window,
				out.mode,
			)
	}
}

const liftFrame = (model: Model, result: FrameReturn, context: PageContext): Return => {
	const next: Model = { ...model, frame: result.frame }
	const commands = Command.mapMessages(result.commands, (message) => Message.GotFrameMessage({ message }))
	const out = result.out === null ? { model: next } : applyOut(next, result.out, context)
	return { ...out, commands: [...commands, ...(out.commands ?? [])] }
}

const sheetOut = (model: Model, out: SheetOut): Return =>
	out._tag === "Dismissed"
		? navigate(model, { review: undefined })
		: navigate(model, { review: out.reviewId })

const liftSheet = (model: Model, result: SheetReturn): Return => {
	const next: Model = { ...model, sheet: result.sheet }
	const commands = Command.mapMessages(result.commands, (message) => Message.GotSheetMessage({ message }))
	const out = result.out === null ? { model: next } : sheetOut(next, result.out)
	return { ...out, commands: [...commands, ...(out.commands ?? [])] }
}

const combine = (first: Return, second: (model: Model) => Return): Return => {
	const next = second(first.model)
	return {
		...next,
		commands: [...(first.commands ?? []), ...(next.commands ?? [])],
		outMessage: next.outMessage ?? first.outMessage,
	}
}

const SELECT_FIELD = { severity: "severitySelect", category: "categorySelect", state: "stateSelect" } as const

/** `FilterSelect`: only a listed option reaches the URL; "all" clears it. */
const filterPatch = (filter: FilterKey, value: string): Partial<Search> => {
	switch (filter) {
		case "severity":
			return { severity: PrReviewSeverity.literals.find((literal) => literal === value) }
		case "category":
			return { category: PrReviewCategory.literals.find((literal) => literal === value) }
		case "state":
			return { state: PrReviewFindingStatus.literals.find((literal) => literal === value) }
	}
}

const withSelects = (model: Model, search: Search): Model => ({
	...model,
	severitySelect: { ...model.severitySelect, value: search.severity ?? ALL },
	categorySelect: { ...model.categorySelect, value: search.category ?? ALL },
	stateSelect: { ...model.stateSelect, value: search.state ?? ALL },
	searchDraft: syncedDraft(model.searchDraft, search.q),
})

// ENTRY POINTS

export const init = (
	route: { readonly search: Search },
	context: PageContext,
	carried: Carried = noCarry,
): Return => {
	const frame = initFrame(FRAME_ID, route.search, route.search.author, DEFAULT_PRESET, context, carried)
	const select = (field: string) => Select.init(`${FRAME_ID}-${field}`, { value: ALL, selectedIndex: null })
	const model: Model = withSelects(
		{
			search: route.search,
			frame: frame.frame,
			findings: Keyed.idle(),
			findingsCache: carried.retained.findings,
			authors: Keyed.idle(),
			authorsCache: carried.retained.analytics,
			limit: PAGE,
			severitySelect: select("severity"),
			categorySelect: select("category"),
			stateSelect: select("state"),
			searchDraft: route.search.q ?? "",
			searchGeneration: 0,
			timeTooltip: Tooltip.init(`${FRAME_ID}-time`),
			sheet: {
				...initSheet(`${FRAME_ID}-review`),
				detailCache: carried.retained.details,
				ciCache: carried.retained.ciRuns,
				nowMs: carried.nowMs,
			},
		},
		route.search,
	)
	return combine(liftFrame(model, frame, context), (next) =>
		liftSheet(next, syncSheet(next.sheet, route.search.review, context, next.frame.nowMs)),
	)
}

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	const next = withSelects({ ...model, search: route.search }, route.search)
	return combine(
		liftFrame(
			next,
			frameRouteChanged(
				next.frame,
				model.search,
				route.search,
				route.search.author,
				DEFAULT_PRESET,
				context,
			),
			context,
		),
		(changed) =>
			liftSheet(changed, syncSheet(changed.sheet, route.search.review, context, changed.frame.nowMs)),
	)
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	model.frame.window === null ? { model } : request(model, context, model.frame.window, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		GotFrameMessage: ({ message: inner }) =>
			liftFrame(model, updateFrame(model.frame, inner, model.search, DEFAULT_PRESET, context), context),
		CompletedFetchFindings: ({ key, result }) => ({
			model: {
				...model,
				findings: Keyed.accept(model.findings, key, result),
				findingsCache: remember(model.findingsCache, model.frame.nowMs, key, result),
			},
		}),
		CompletedFetchAuthors: ({ key, result }) => ({
			model: {
				...model,
				authors: Keyed.accept(model.authors, key, result),
				authorsCache: remember(model.authorsCache, model.frame.nowMs, key, result),
			},
		}),
		ClickedRetry: () =>
			model.frame.window === null ? { model } : request(model, context, model.frame.window, "Refresh"),
		ClickedClearFilters: () =>
			navigate(model, {
				repo: undefined,
				author: undefined,
				severity: undefined,
				category: undefined,
				state: undefined,
				q: undefined,
			}),
		ClickedFinding: ({ reviewId }) => navigate(model, { review: reviewId }),
		ClickedLoadMore: () => {
			const next = { ...model, limit: Math.min(model.limit + PAGE, MAX_ROWS) }
			return next.frame.window === null
				? { model: next }
				: request(next, context, next.frame.window, "Load")
		},
		GotFilterSelectMessage: ({ filter, message: inner }) => {
			const field = SELECT_FIELD[filter]
			const next = Select.update(model[field], inner)
			const lifted: Return = {
				model: { ...model, [field]: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotFilterSelectMessage({ filter, message: m }),
				),
			}
			const picked = next.outMessage
			return picked === undefined
				? lifted
				: combine(lifted, (current) => navigate(current, filterPatch(filter, picked.value)))
		},
		GotTimeTooltipMessage: ({ message: inner }) => {
			const next = Tooltip.update(model.timeTooltip, inner)
			return {
				model: { ...model, timeTooltip: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotTimeTooltipMessage({ message: m }),
				),
			}
		},
		ChangedSearchDraft: ({ value }) => {
			const searchGeneration = model.searchGeneration + 1
			return {
				model: { ...model, searchDraft: value, searchGeneration },
				commands: [WaitSearchDebounce({ generation: searchGeneration })],
			}
		},
		ElapsedSearchDebounce: ({ generation }) =>
			generation === model.searchGeneration && draftQuery(model.searchDraft) !== model.search.q
				? navigate(model, { q: draftQuery(model.searchDraft) })
				: { model },
		GotSheetMessage: ({ message: inner }) => liftSheet(model, updateSheet(model.sheet, inner, context)),
	})

/** What this tab hands the next one. */
export const retainedOf = (model: Model): Partial<Retained> => ({
	...frameRetained(model.frame),
	analytics: model.authorsCache,
	findings: model.findingsCache,
	details: model.sheet.detailCache,
	ciRuns: model.sheet.ciCache,
})
