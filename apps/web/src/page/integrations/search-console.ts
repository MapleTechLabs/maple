import {
	SearchConsoleAvailableSitesResponse,
	SearchConsoleSaveSitesRequest,
	type SearchConsoleIntegrationStatus,
} from "@maple/domain/http"
import { Effect, Schema, Array as Arr } from "effect"
import { AsyncData, Command } from "foldkit"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure, toLoadFailure } from "@maple/views/data/load-failure"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { Message } from "./message"

// The Google Search Console card: the property picker's state and its reads and writes.

export const SearchConsoleCardModel = Schema.Struct({
	/** The Google account's properties, live from Google. */
	sites: KeyedSchema(SearchConsoleAvailableSitesResponse, LoadFailure),
	/** The picker's unsaved choice; null follows the saved selection. */
	draft: Schema.NullOr(Schema.Array(Schema.String)),
	isSaving: Schema.Boolean,
})
export type SearchConsoleCardModel = typeof SearchConsoleCardModel.Type

export const initSearchConsoleCard = (): SearchConsoleCardModel => ({
	sites: { key: null, data: AsyncData.Idle() },
	draft: null,
	isSaving: false,
})

/** The saved, enabled properties: what the importer reads. */
export const savedSelection = (status: SearchConsoleIntegrationStatus): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(status.sites, (site) => site.enabled),
		(site) => site.siteUrl,
	)

/** What the picker shows checked: the draft once touched, else the saved selection. */
export const selectionOf = (
	card: SearchConsoleCardModel,
	status: SearchConsoleIntegrationStatus,
): ReadonlyArray<string> => card.draft ?? savedSelection(status)

/** Whether the draft differs from what is saved, as sets. */
export const isDirty = (card: SearchConsoleCardModel, status: SearchConsoleIntegrationStatus): boolean => {
	if (card.draft === null) return false
	const saved = savedSelection(status)
	return (
		card.draft.length !== saved.length || Arr.some(card.draft, (siteUrl) => !Arr.contains(saved, siteUrl))
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
	messages: [Message.CompletedLoadSearchConsoleSites],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.searchConsoleSites()
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedLoadSearchConsoleSites({ key, result })),
		),
})

export const SaveSearchConsoleSites = Command.define("SaveSearchConsoleSites", {
	args: { siteUrls: Schema.Array(Schema.String) },
	messages: [Message.CompletedSaveSearchConsoleSites],
	execute: ({ siteUrls }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const payload = yield* Schema.decodeEffect(SearchConsoleSaveSitesRequest)({ siteUrls })
			yield* client.integrations.searchConsoleSaveSites({ payload })
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedSaveSearchConsoleSites({ failure: toLoadFailure(error) }),
				onSuccess: () => Message.CompletedSaveSearchConsoleSites({ failure: null }),
			}),
		),
})
