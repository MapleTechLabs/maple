import {
	type V2PlanetScaleIntegration,
	V2PlanetScaleMetricsTokenRequest,
	V2PlanetScaleOrganizationList,
	V2PlanetScaleSelectOrganizationRequest,
} from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { MapleApiV2Client } from "../../platform/api-clients"
import * as Dialog from "../../ui/dialog"
import * as Field from "../../ui/field"
import { derivePlanetScaleSetup } from "../../components/integrations/planetscale-setup-steps"
import { Message } from "./message"

// `PlanetScaleIntegrationCard` and its connect flow: state and IO.

/** Where branch metrics come from: the OAuth grant's metrics API, or a Prometheus service token. */
export const PlanetscaleMetricsMethod = Schema.Literals(["api", "service_token"])
export type PlanetscaleMetricsMethod = typeof PlanetscaleMetricsMethod.Type

export const PlanetscaleCardModel = Schema.Struct({
	/** `PlanetScaleOrgPicker`: inline on the flow's Choose data step, in a dialog for Edit data. */
	pickerDialog: Dialog.Model,
	organizations: KeyedSchema(V2PlanetScaleOrganizationList, LoadFailure),
	selectedOrg: Schema.NullOr(Schema.String),
	includeBranches: Field.Model,
	excludeBranches: Field.Model,
	isSelecting: Schema.Boolean,
	/** `PlanetScaleMetricsHealth`'s "Show details". */
	isDetailsOpen: Schema.Boolean,
	/** The Connect step's metrics choice; null follows the connection's current `metrics_auth`. */
	metricsMethod: Schema.NullOr(PlanetscaleMetricsMethod),
	tokenId: Field.Model,
	tokenSecret: Field.Model,
	isSavingToken: Schema.Boolean,
	/** PlanetScale rejected the token; nothing was saved. */
	tokenError: Schema.NullOr(Schema.String),
	/** A token is attached and the form is open to replace it. */
	isReplacingToken: Schema.Boolean,
	/** The first clock read while awaiting first metrics; null while not awaiting. */
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
	metricsMethod: null,
	tokenId: Field.init(),
	tokenSecret: Field.init(),
	isSavingToken: false,
	tokenError: null,
	isReplacingToken: false,
	watchStartedAt: null,
})

/** The card stops watching for first metrics after this long and offers "Check again". */
export const WATCH_LIMIT_MS = 30 * 60 * 1000

/** Connected, nothing collected yet and the grant works: the card watches the status. */
export const isAwaitingFirstMetrics = (status: V2PlanetScaleIntegration | null, nowMs: number): boolean =>
	status !== null && status.connected && derivePlanetScaleSetup(status, nowMs).awaitingFirstScrape

export const isWatchExpired = (card: PlanetscaleCardModel, nowMs: number): boolean =>
	card.watchStartedAt !== null && nowMs - card.watchStartedAt >= WATCH_LIMIT_MS

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

export const SetMetricsToken = Command.define("SetPlanetscaleMetricsToken", {
	args: { tokenId: Schema.String, tokenSecret: Schema.String },
	messages: [Message.CompletedPlanetscaleToken],
	execute: ({ tokenId, tokenSecret }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const payload = yield* Schema.decodeUnknownEffect(V2PlanetScaleMetricsTokenRequest)({
				token_id: tokenId,
				token_secret: tokenSecret,
			})
			yield* client.planetscaleIntegration.setMetricsToken({ payload })
		}).pipe(
			Effect.match({
				onFailure: (error) => Message.CompletedPlanetscaleToken({ failure: toLoadFailure(error) }),
				onSuccess: () => Message.CompletedPlanetscaleToken({ failure: null }),
			}),
		),
})
