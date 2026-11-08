import type { SearchConsoleAvailableSitesResponse, SearchConsoleIntegrationStatus } from "@maple/domain/http"
import { Option, Result, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { integrationOfSearch } from "./catalog"
import type { Message } from "./message"
import type { Model } from "./model"
import {
	FetchSearchConsoleSites,
	initSearchConsoleCard,
	PrimeSearchConsole,
	SaveSearchConsoleSites,
	type SearchConsoleCardModel,
	selectionOf,
} from "./search-console"
import { chain, requestStatus } from "./update-status"

// The Google Search Console card's state changes: the property list and the saved selection.

type Return = PageReturn<Model, Message>

const withCard = (model: Model, card: Partial<SearchConsoleCardModel>): Model => ({
	...model,
	searchConsoleCard: { ...model.searchConsoleCard, ...card },
})

const statusOf = (model: Model): SearchConsoleIntegrationStatus | null =>
	Option.getOrNull(AsyncData.getData(model.statuses.searchConsole.data))

/** Which grant the card shows; any change (disconnect, another Google account, a revoke) starts the card over. */
const grantOf = (status: SearchConsoleIntegrationStatus): string =>
	status.connected ? `${status.accountEmail ?? ""}|${status.revoked ? "revoked" : "live"}` : "none"

/** Drops the picker's sites and draft when a status read shows a different grant than `before` did. */
export const resetOnGrantChange = (before: Model, after: Model): Model => {
	const previous = statusOf(before)
	const next = statusOf(after)
	return previous !== null && next !== null && grantOf(previous) !== grantOf(next)
		? { ...after, searchConsoleCard: initSearchConsoleCard() }
		: after
}

/** The property list is read live from Google, so only on this card and only with a usable grant. */
export const requestSites = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const status = statusOf(model)
	if (
		integrationOfSearch(model.search.integration) !== "google-search-console" ||
		status === null ||
		!status.connected ||
		status.revoked
	)
		return { model }
	// Keyed by grant too, so a list still in flight for the previous account is never accepted.
	const key = requestKey(context.orgId, "integrations.searchConsoleSites", { grant: grantOf(status) })
	return Option.match(Keyed.request(model.searchConsoleCard.sites, key, mode), {
		onNone: () => ({ model }),
		onSome: (sites) => ({
			model: withCard(model, { sites }),
			commands: [FetchSearchConsoleSites({ key })],
		}),
	})
}

export const completedSites = (
	model: Model,
	key: string,
	result: Result.Result<SearchConsoleAvailableSitesResponse, LoadFailure>,
): Return => ({
	model: withCard(model, { sites: Keyed.accept(model.searchConsoleCard.sites, key, result) }),
})

export const toggledSite = (model: Model, siteUrl: string): Return => {
	const status = statusOf(model)
	if (status === null || model.searchConsoleCard.isSaving) return { model }
	const current = selectionOf(model.searchConsoleCard, status)
	const draft = Arr.contains(current, siteUrl)
		? Arr.filter(current, (selected) => selected !== siteUrl)
		: Arr.append(current, siteUrl)
	return { model: withCard(model, { draft }) }
}

export const clickedSave = (model: Model): Return => {
	const status = statusOf(model)
	const card = model.searchConsoleCard
	if (status === null || card.isSaving) return { model }
	return {
		model: withCard(model, { isSaving: true }),
		commands: [SaveSearchConsoleSites({ siteUrls: selectionOf(card, status) })],
	}
}

/** A save keeps the card saving, draft included, until the status re-read reflects it; a failure keeps the draft for a retry. */
export const completedSave = (model: Model, context: PageContext, failure: LoadFailure | null): Return => {
	if (failure !== null)
		return {
			model: withCard(model, { isSaving: false }),
			outMessage: PageOutMessage.RequestedToast({
				type: "error",
				title: "Couldn't save Search Console properties",
				description: failure.message,
			}),
		}
	return chain(withCard(model, { isSettling: true }), [
		(next) => ({
			model: next,
			outMessage: PageOutMessage.RequestedToast({
				type: "success",
				title: "Search Console properties saved",
				description: "",
			}),
		}),
		(next) => requestStatus(next, context, "searchConsole", "Supersede"),
		(next) => ({ model: next, commands: [PrimeSearchConsole()] }),
	])
}

/** The first import ran (or gave up); re-read the status so the rows show what it imported. */
export const completedPrime = (model: Model, context: PageContext): Return =>
	requestStatus(model, context, "searchConsole", "Supersede")

/** Any answer to the status read retires a finished save's draft; the checkboxes then follow the saved rows. */
export const settledStatus = (model: Model): Model =>
	model.searchConsoleCard.isSettling
		? withCard(model, { isSaving: false, isSettling: false, draft: null })
		: model
