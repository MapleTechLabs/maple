import { Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import { AppRoute, hrefOf } from "../../../route"
import type { CodeReviewTeamSearch } from "../../../route/search"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { epochWindow } from "../kit/api"
import type { FrameOut, FrameReturn } from "../kit/frame"
import {
	type Carried,
	frameRetained,
	frameRouteChanged,
	initFrame,
	noCarry,
	updateFrame,
} from "../kit/frame-update"
import { cachedStep, remember } from "../kit/page-steps"
import type { Retained } from "../kit/retained"
import { FetchTeam, Message, type Model } from "./model"
import type { PresetValue } from "../../kit/time-controls"

export type Search = typeof CodeReviewTeamSearch.Type
type Return = PageReturn<Model, Message>

/** A month: enough merged pull requests per person for a median to mean something. */
export const DEFAULT_PRESET: PresetValue = "1mo"
const FRAME_ID = "code-review-team"

const searchHref = (search: Search) => hrefOf(AppRoute.CodeReviewTeam({ search }))

const navigate = (model: Model, patch: Partial<Search>): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: searchHref({ ...model.search, ...patch }),
		isReplace: false,
	}),
})

const request = (model: Model, context: PageContext, window: TimeWindow, mode: Keyed.RequestMode): Return => {
	const query = { ...epochWindow(window), repositoryId: model.search.repo }
	const step = cachedStep(
		model.teamCache,
		model.frame.nowMs,
		model.team,
		requestKey(context.orgId, "codeReview.team", { query }),
		mode,
		(team) => ({ team }),
		(key) => FetchTeam({ key, query }),
	)
	return { model: { ...model, ...step.patch }, commands: step.commands }
}

const applyOut = (model: Model, out: FrameOut, context: PageContext): Return => {
	switch (out._tag) {
		case "PickedRepository":
			return navigate(model, { repo: out.repo })
		// The team tab has no author or workflow filter.
		case "PickedOption":
			return { model }
		case "PickedWindow":
			return navigate(model, out.window)
		case "RefusedWindow":
			return { model, outMessage: out.toast }
		case "ResolvedWindow":
			return request(model, context, out.window, out.mode)
	}
}

const liftFrame = (model: Model, result: FrameReturn, context: PageContext): Return => {
	const next: Model = { ...model, frame: result.frame }
	const commands = Command.mapMessages(result.commands, (message) => Message.GotFrameMessage({ message }))
	const out = result.out === null ? { model: next } : applyOut(next, result.out, context)
	return { ...out, commands: [...commands, ...(out.commands ?? [])] }
}

export const init = (
	route: { readonly search: Search },
	context: PageContext,
	carried: Carried = noCarry,
): Return => {
	const frame = initFrame(FRAME_ID, route.search, undefined, DEFAULT_PRESET, context, carried)
	const model: Model = {
		search: route.search,
		frame: frame.frame,
		team: Keyed.idle(),
		teamCache: carried.retained.team,
	}
	return liftFrame(model, frame, context)
}

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return =>
	searchHref(model.search) === searchHref(route.search)
		? { model }
		: liftFrame(
				{ ...model, search: route.search },
				frameRouteChanged(
					model.frame,
					model.search,
					route.search,
					undefined,
					DEFAULT_PRESET,
					context,
				),
				context,
			)

export const contextChanged = (model: Model, context: PageContext): Return =>
	model.frame.window === null ? { model } : request(model, context, model.frame.window, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		GotFrameMessage: ({ message: inner }) =>
			liftFrame(model, updateFrame(model.frame, inner, model.search, DEFAULT_PRESET, context), context),
		CompletedFetchTeam: ({ key, result }) => ({
			model: {
				...model,
				team: Keyed.accept(model.team, key, result),
				teamCache: remember(model.teamCache, model.frame.nowMs, key, result),
			},
		}),
		ClickedRetry: () =>
			model.frame.window === null ? { model } : request(model, context, model.frame.window, "Refresh"),
		ClickedClearFilters: () => navigate(model, { repo: undefined }),
		// A second click on the sorted column goes back to by person.
		ClickedSort: ({ sort }) =>
			navigate(model, { sort: sort === "person" || sort === model.search.sort ? undefined : sort }),
		SelectedView: ({ view }) => navigate(model, { ranked: view === "ranked" ? true : undefined }),
	})

/** What this tab hands the next one. */
export const retainedOf = (model: Model): Partial<Retained> => ({
	...frameRetained(model.frame),
	team: model.teamCache,
})
