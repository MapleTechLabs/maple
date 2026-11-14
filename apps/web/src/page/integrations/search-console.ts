import {
	SearchConsoleAvailableSitesResponse,
	SearchConsoleSaveSitesRequest,
	type SearchConsoleIntegrationStatus,
} from "@maple/domain/http"
import { Effect, Option, Schema, Array as Arr } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure, toLoadFailure, settleTo } from "@maple/views/data/load-failure"
import { MapleInternalApiClient } from "../../platform/api-clients"

export const SearchConsoleCardModel = Schema.Struct({
	/** The Google account's properties, live from Google. */
	sites: KeyedSchema(SearchConsoleAvailableSitesResponse, LoadFailure),
	/** The picker's unsaved choice; null follows the saved selection. */
	draft: Schema.NullOr(Schema.Array(Schema.String)),
	/** True from a save's start until the status re-read after it lands. */
	isSaving: Schema.Boolean,
	/** The save landed; the status re-read it asked for is still out. */
	isSettling: Schema.Boolean,
})
export type SearchConsoleCardModel = typeof SearchConsoleCardModel.Type

export const initSearchConsoleCard = (): SearchConsoleCardModel => ({
	sites: { key: null, data: AsyncData.Idle() },
	draft: null,
	isSaving: false,
	isSettling: false,
})

/** The Search Console module's own messages; the hub carries them in `GotSearchConsoleMessage`. */
export const SearchConsoleMessage = defineMessageUnion({
	CompletedLoadSites: {
		key: Schema.String,
		result: Schema.Result(SearchConsoleAvailableSitesResponse, LoadFailure),
	},
	/** A property's checkbox in the picker. */
	ToggledSite: { siteUrl: Schema.String },
	ClickedSave: {},
	ClickedRetrySites: {},
	CompletedSave: { failure: Schema.NullOr(LoadFailure) },
	CompletedPrime: {},
})
export type SearchConsoleMessage = typeof SearchConsoleMessage.Type

/** The hub's status read for Search Console, shared with the headers. */
export const SEARCH_CONSOLE_STATUS_READ = {
	name: "LoadIntegrationsSearchConsoleStatus",
	read: (_refresh: boolean) =>
		Effect.flatMap(MapleInternalApiClient, (client) => client.integrations.searchConsoleStatus()),
}

/** The saved, enabled properties: what the importer reads. */
export const savedSelection = (status: SearchConsoleIntegrationStatus): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(status.sites, (site) => site.enabled),
		(site) => site.siteUrl,
	)

/** The properties the connected account can import now, once Google's list has loaded. */
const selectableOf = (card: SearchConsoleCardModel): ReadonlyArray<string> | null =>
	Option.match(AsyncData.getData(card.sites.data), {
		onNone: () => null,
		onSome: (data) =>
			Arr.map(
				Arr.filter(data.sites, (site) => site.selectable),
				(site) => site.siteUrl,
			),
	})

/** What the picker shows checked: the draft once touched, else the saved selection, never an unselectable site. */
export const selectionOf = (
	card: SearchConsoleCardModel,
	status: SearchConsoleIntegrationStatus,
): ReadonlyArray<string> => {
	const selection = card.draft ?? savedSelection(status)
	const selectable = selectableOf(card)
	return selectable === null
		? selection
		: Arr.filter(selection, (siteUrl) => Arr.contains(selectable, siteUrl))
}

/** Saved properties the account can no longer import (gone from Google's list or unverified); a save drops them. */
export const unavailableSaved = (
	card: SearchConsoleCardModel,
	status: SearchConsoleIntegrationStatus,
): ReadonlyArray<string> => {
	const selectable = selectableOf(card)
	return selectable === null
		? []
		: Arr.filter(savedSelection(status), (siteUrl) => !Arr.contains(selectable, siteUrl))
}

/** Whether the picker's selection differs from what is saved, as sets. */
export const isDirty = (card: SearchConsoleCardModel, status: SearchConsoleIntegrationStatus): boolean => {
	const selection = selectionOf(card, status)
	const saved = savedSelection(status)
	return (
		selection.length !== saved.length || Arr.some(selection, (siteUrl) => !Arr.contains(saved, siteUrl))
	)
}

/** Google's permission level, as the picker labels it. */
export const permissionLabel = (permissionLevel: string): string => {
	switch (permissionLevel) {
		case "siteOwner":
			return "Owner"
		case "siteFullUser":
			return "Full user"
		case "siteRestrictedUser":
			return "Restricted user"
		case "siteUnverifiedUser":
			return "Unverified"
		default:
			return permissionLevel
	}
}

export const FetchSearchConsoleSites = Command.define("FetchSearchConsoleSites", {
	args: { key: Schema.String },
	messages: [SearchConsoleMessage.CompletedLoadSites],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.searchConsoleSites()
		}).pipe(settleTo((result) => SearchConsoleMessage.CompletedLoadSites({ key, result }))),
})

/** `searchConsolePrime`: a first import now instead of on the next cron tick; a failure is left to the cron. */
export const PrimeSearchConsole = Command.define("PrimeSearchConsole", {
	messages: [SearchConsoleMessage.CompletedPrime],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		return yield* client.integrations.searchConsolePrime()
	}).pipe(Effect.ignore, Effect.as(SearchConsoleMessage.CompletedPrime())),
})

export const SaveSearchConsoleSites = Command.define("SaveSearchConsoleSites", {
	args: { siteUrls: Schema.Array(Schema.String) },
	messages: [SearchConsoleMessage.CompletedSave],
	execute: ({ siteUrls }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const payload = yield* Schema.decodeEffect(SearchConsoleSaveSitesRequest)({ siteUrls })
			yield* client.integrations.searchConsoleSaveSites({ payload })
		}).pipe(
			Effect.match({
				onFailure: (error) => SearchConsoleMessage.CompletedSave({ failure: toLoadFailure(error) }),
				onSuccess: () => SearchConsoleMessage.CompletedSave({ failure: null }),
			}),
		),
})
