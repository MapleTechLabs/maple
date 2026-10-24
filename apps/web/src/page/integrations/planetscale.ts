import { V2PlanetScaleOrganizationList, V2PlanetScaleSelectOrganizationRequest } from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { MapleApiV2Client } from "../../platform/api-clients"
import * as Dialog from "../../ui/dialog"
import * as Field from "../../ui/field"
import { Message } from "./message"

// `PlanetScaleIntegrationCard` and its parts: state and IO.

export const PlanetscaleCardModel = Schema.Struct({
	/** `PlanetScaleOrgPicker`, inline while the org is pending, in a dialog to change it. */
	pickerDialog: Dialog.Model,
	organizations: KeyedSchema(V2PlanetScaleOrganizationList, LoadFailure),
	selectedOrg: Schema.NullOr(Schema.String),
	includeBranches: Field.Model,
	excludeBranches: Field.Model,
	isSelecting: Schema.Boolean,
	/** `PlanetScaleMetricsHealth`'s "Show details". */
	isDetailsOpen: Schema.Boolean,
	/** When the card started watching for the first scrape (`watchStartedAt`). */
	watchStartedAt: Schema.NullOr(Schema.Number),
})
export type PlanetscaleCardModel = typeof PlanetscaleCardModel.Type

export const initPlanetscaleCard = (): PlanetscaleCardModel => ({
	pickerDialog: Dialog.init("planetscale-org-picker", "dialog"),
	organizations: { key: null, data: AsyncData.Idle() },
	selectedOrg: null,
	includeBranches: Field.init(),
	excludeBranches: Field.init(),
	isSelecting: false,
	isDetailsOpen: false,
	watchStartedAt: null,
})

/** Comma or newline separated globs, trimmed. */
export const parsePatternList = (value: string): ReadonlyArray<string> =>
	value
		.split(/[\n,]/)
		.map((pattern) => pattern.trim())
		.filter((pattern) => pattern.length > 0)

export const FetchOrganizations = Command.define("FetchPlanetscaleOrganizations", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchOrganizations],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.planetscaleIntegration.organizations()
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchOrganizations({ key, result })),
		),
})

export const SelectOrganization = Command.define("SelectPlanetscaleOrganization", {
	args: {
		organization: Schema.String,
		includeBranches: Schema.Array(Schema.String),
		excludeBranches: Schema.Array(Schema.String),
	},
	messages: [Message.CompletedSelectOrganization],
	execute: ({ organization, includeBranches, excludeBranches }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const withInclude = includeBranches.length > 0 ? { include_branches: includeBranches } : {}
			const withExclude = excludeBranches.length > 0 ? { exclude_branches: excludeBranches } : {}
			const payload = yield* Schema.decodeUnknownEffect(V2PlanetScaleSelectOrganizationRequest)({
				organization,
				...withInclude,
				...withExclude,
			})
			yield* client.planetscaleIntegration.selectOrganization({ payload })
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedSelectOrganization({ organization, failure: toLoadFailure(error) }),
				onSuccess: () => Message.CompletedSelectOrganization({ organization, failure: null }),
			}),
		),
})
