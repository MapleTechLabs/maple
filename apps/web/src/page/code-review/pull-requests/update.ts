import { Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import { AppRoute, hrefOf } from "../../../route"
import type { CodeReviewPullRequestsSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
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
import { initSheet, syncSheet, updateSheet, type SheetReturn } from "../kit/review-sheet-update"
import { FetchReviewAuthors, FetchReviews } from "./command"
import { Message, type Model } from "./model"

export type Search = typeof CodeReviewPullRequestsSearch.Type
type Return = PageReturn<Model, Message>

export const DEFAULT_PRESET = "30d"
export const PAGE = 50
export const MAX_ROWS = 200
const FRAME_ID = "code-review-pull-requests"

export const STATUS_LABELS = {
	all: "All statuses",
	completed: "Completed",
	running: "Reviewing",
	queued: "Queued",
	failed: "Failed",
	skipped: "Skipped",
} as const

type Status = NonNullable<Search["status"]>
const isStatus = (value: string): value is Status =>
	value === "completed" ||
	value === "failed" ||
	value === "skipped" ||
	value === "running" ||
	value === "queued"

const searchHref = (search: Search) => hrefOf(AppRoute.CodeReviewPullRequests({ search }))

/** `onChange`: a filter change starts the list over at one page; opening a review keeps it. */
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
	const query = { ...base, author: model.search.author, status: model.search.status, limit: model.limit }
	const authorsQuery = { ...base, author: undefined }
	const nowMs = model.frame.nowMs
	const step = mergeSteps<Model, Message>([
		cachedStep(
			model.reviewsCache,
			nowMs,
			model.reviews,
			requestKey(context.orgId, "codeReview.listReviews", { query }),
			mode,
			(reviews) => ({ reviews }),
			(key) => FetchReviews({ key, query }),
		),
		cachedStep(
			model.authorsCache,
			nowMs,
			model.authors,
			requestKey(context.orgId, "codeReview.analytics", { query: authorsQuery }),
			"Load",
			(authors) => ({ authors }),
			(key) => FetchReviewAuthors({ key, query: authorsQuery }),
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

// ENTRY POINTS

export const init = (
	route: { readonly search: Search },
	context: PageContext,
	carried: Carried = noCarry,
): Return => {
	const frame = initFrame(FRAME_ID, route.search, route.search.author, DEFAULT_PRESET, context, carried)
	const model: Model = {
		search: route.search,
		frame: frame.frame,
		reviews: Keyed.idle(),
		reviewsCache: carried.retained.reviews,
		authors: Keyed.idle(),
		authorsCache: carried.retained.analytics,
		limit: PAGE,
		statusSelect: Select.init(`${FRAME_ID}-status`, {
			value: route.search.status ?? ALL,
			selectedIndex: null,
		}),
		sheet: {
			...initSheet(`${FRAME_ID}-review`),
			detailCache: carried.retained.details,
			ciCache: carried.retained.ciRuns,
			nowMs: carried.nowMs,
		},
	}
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
	const next: Model = {
		...model,
		search: route.search,
		statusSelect: { ...model.statusSelect, value: route.search.status ?? ALL },
	}
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

const refreshList = (model: Model, context: PageContext): Return =>
	model.frame.window === null ? { model } : request(model, context, model.frame.window, "Refresh")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		GotFrameMessage: ({ message: inner }) =>
			liftFrame(model, updateFrame(model.frame, inner, model.search, DEFAULT_PRESET, context), context),
		CompletedFetchReviews: ({ key, result }) => ({
			model: {
				...model,
				reviews: Keyed.accept(model.reviews, key, result),
				reviewsCache: remember(model.reviewsCache, model.frame.nowMs, key, result),
			},
		}),
		CompletedFetchAuthors: ({ key, result }) => ({
			model: {
				...model,
				authors: Keyed.accept(model.authors, key, result),
				authorsCache: remember(model.authorsCache, model.frame.nowMs, key, result),
			},
		}),
		ClickedRetry: () => refreshList(model, context),
		// `useIntervalRefresh`: only the list refetches while a review is queued or running.
		TickedPoll: () => refreshList(model, context),
		ClickedClearFilters: () => navigate(model, { repo: undefined, author: undefined, status: undefined }),
		ClickedReview: ({ reviewId }) => navigate(model, { review: reviewId }),
		ClickedLoadMore: () => {
			const next = { ...model, limit: Math.min(model.limit + PAGE, MAX_ROWS) }
			return next.frame.window === null
				? { model: next }
				: request(next, context, next.frame.window, "Load")
		},
		GotStatusSelectMessage: ({ message: inner }) => {
			const next = Select.update(model.statusSelect, inner)
			const lifted: Return = {
				model: { ...model, statusSelect: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotStatusSelectMessage({ message: m }),
				),
			}
			if (next.outMessage === undefined) return lifted
			const value = next.outMessage.value
			return combine(lifted, (current) =>
				navigate(current, { status: isStatus(value) ? value : undefined }),
			)
		},
		GotSheetMessage: ({ message: inner }) => liftSheet(model, updateSheet(model.sheet, inner, context)),
	})

/** What this tab hands the next one. */
export const retainedOf = (model: Model): Partial<Retained> => ({
	...frameRetained(model.frame),
	analytics: model.authorsCache,
	reviews: model.reviewsCache,
	details: model.sheet.detailCache,
	ciRuns: model.sheet.ciCache,
})
