import type { SearchConsoleIntegrationStatus } from "@maple/domain/http"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import { HubRequest, type ProviderEnv, type ProviderReturn, type StatusAnswer } from "./provider"
import {
	FetchSearchConsoleSites,
	initSearchConsoleCard,
	PrimeSearchConsole,
	SaveSearchConsoleSites,
	type SearchConsoleCardModel,
	SearchConsoleMessage,
	selectionOf,
} from "./search-console"

type Env = ProviderEnv<SearchConsoleIntegrationStatus>
type Return = ProviderReturn<SearchConsoleCardModel, SearchConsoleMessage>

const statusOf = (status: Env["status"]): SearchConsoleIntegrationStatus | null =>
	Option.getOrNull(AsyncData.getData(status.data))

/** Which grant the card shows; any change (disconnect, another Google account, a revoke) starts the card over. */
const grantOf = (status: SearchConsoleIntegrationStatus): string =>
	status.connected ? `${status.accountEmail ?? ""}|${status.revoked ? "revoked" : "live"}` : "none"

/** Drops the picker's sites and draft when the status shows a different grant than `previous` did. */
const resetOnGrantChange = (
	model: SearchConsoleCardModel,
	previous: Env["status"],
	env: Env,
): SearchConsoleCardModel => {
	const before = statusOf(previous)
	const after = statusOf(env.status)
	return before !== null && after !== null && grantOf(before) !== grantOf(after)
		? initSearchConsoleCard()
		: model
}

/**
 * The property list is read live from Google, so only on this card and only with a usable grant.
 * `Supersede` after a connect: the same account may have granted or dropped properties since.
 */
export const requestSites = (model: SearchConsoleCardModel, env: Env, mode: Keyed.ReadMode): Return => {
	const status = statusOf(env.status)
	if (!env.isShown || status === null || !status.connected || status.revoked) return { model }
	// Keyed by grant too, so a list still in flight for the previous account is never accepted.
	const key = requestKey(env.context.orgId, "integrations.searchConsoleSites", { grant: grantOf(status) })
	return Option.match(Keyed.requestFor(model.sites, key, mode), {
		onNone: () => ({ model }),
		onSome: (sites) => ({ model: { ...model, sites }, commands: [FetchSearchConsoleSites({ key })] }),
	})
}

const toggledSite = (model: SearchConsoleCardModel, env: Env, siteUrl: string): Return => {
	const status = statusOf(env.status)
	if (status === null || model.isSaving) return { model }
	const current = selectionOf(model, status)
	const draft = Arr.contains(current, siteUrl)
		? Arr.filter(current, (selected) => selected !== siteUrl)
		: Arr.append(current, siteUrl)
	return { model: { ...model, draft } }
}

const clickedSave = (model: SearchConsoleCardModel, env: Env): Return => {
	const status = statusOf(env.status)
	if (status === null || model.isSaving) return { model }
	return {
		model: { ...model, isSaving: true },
		commands: [SaveSearchConsoleSites({ siteUrls: selectionOf(model, status) })],
	}
}

/** A save keeps the card saving, draft included, until the status re-read reflects it; a failure keeps the draft for a retry. */
const completedSave = (model: SearchConsoleCardModel, failure: LoadFailure | null): Return =>
	failure !== null
		? {
				model: { ...model, isSaving: false },
				requests: [
					HubRequest.toast("error", "Couldn't save Search Console properties", failure.message),
				],
			}
		: {
				model: { ...model, isSettling: true },
				requests: [
					HubRequest.toast("success", "Search Console properties saved"),
					HubRequest.readStatus("Supersede"),
				],
				commands: [PrimeSearchConsole()],
			}

/** Any answer to the status read retires a finished save's draft; the checkboxes then follow the saved rows. */
const settledStatus = (model: SearchConsoleCardModel): SearchConsoleCardModel =>
	model.isSettling ? { ...model, isSaving: false, isSettling: false, draft: null } : model

/** The status read answered: a new grant starts the card over, then the sites are read. */
export const statusAnswered = (
	model: SearchConsoleCardModel,
	env: Env,
	answer: StatusAnswer<SearchConsoleIntegrationStatus>,
): Return => {
	const read = resetOnGrantChange(model, answer.previous, env)
	return requestSites(answer.isCurrent ? settledStatus(read) : read, env, "Load")
}

export const update = (model: SearchConsoleCardModel, message: SearchConsoleMessage, env: Env): Return =>
	SearchConsoleMessage.match<Return>(message, {
		CompletedLoadSites: ({ key, result }) => ({
			model: { ...model, sites: Keyed.accept(model.sites, key, result) },
		}),
		ToggledSite: ({ siteUrl }) => toggledSite(model, env, siteUrl),
		ClickedSave: () => clickedSave(model, env),
		ClickedRetrySites: () => requestSites(model, env, "Refresh"),
		CompletedSave: ({ failure }) => completedSave(model, failure),
		// The first import ran (or gave up); re-read the status so the rows show what it imported.
		CompletedPrime: () => ({ model, requests: [HubRequest.readStatus("Supersede")] }),
	})
