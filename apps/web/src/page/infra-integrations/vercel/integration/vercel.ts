import {
	VercelConnectRequest,
	VercelDiscoverRequest,
	VercelSettingsRequest,
	type VercelIntegrationStatus,
} from "@maple/domain/http"
import { displayError, isUnexpectedError } from "@maple/web-data/lib/error-messages"
import { Array as Arr, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleInternalApiClient } from "../../../../platform/api-clients"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as RadioGroup from "@maple/views/ui/radio-group"
import { DEFAULT_VERCEL_DRAFT, draftOf } from "./vercel-model"
import { Message } from "../../../integrations/message"
import {
	type VercelCardModel,
	type VercelConfigureModel,
	type VercelConfigureTarget,
	VercelDraftSchema,
} from "./vercel-schema"

// `VercelIntegrationCard` and `VercelConfigure`: state and writes.

export const VERCEL_CONFIGURE_DIALOG_ID = "vercel-configure"
export const VERCEL_TOKENS_URL = "https://vercel.com/account/settings/tokens"

/** Until the first sync lands, re-read often enough to see the drains and projects arrive. */
export const VERCEL_SETTLING_REFRESH_MS = 15_000
/** A first sync that has not succeeded by then is a failure the card shows, not something to poll for. */
const SETTLING_WINDOW_MS = 10 * 60_000

export const initVercelCard = (): VercelCardModel => ({
	isSyncing: false,
	isReapplying: false,
	configure: null,
})

export const initVercelConfigure = (
	target: VercelConfigureTarget,
	status: VercelIntegrationStatus | null,
): VercelConfigureModel => {
	const connected = target !== "connect" && status !== null && status.connected ? status : null
	return {
		target: connected === null ? "connect" : target,
		dialog: Dialog.init(VERCEL_CONFIGURE_DIALOG_ID, "dialog"),
		confirm: Dialog.init("vercel-configure-confirm", "alert-dialog"),
		token: Field.init(),
		teams: null,
		team: RadioGroup.init(),
		projects:
			connected === null
				? null
				: Arr.map(connected.projects, ({ id, name, framework }) => ({ id, name, framework })),
		draft: connected === null ? DEFAULT_VERCEL_DRAFT : draftOf(connected),
		projectQuery: "",
		error: null,
		isLookingUp: false,
		isSaving: false,
	}
}

/** The first connected, not rejected, not yet synced 10 minutes: worth re-reading every 15 s. */
export const isVercelSettling = (status: VercelIntegrationStatus, nowMs: number): boolean =>
	status.connected &&
	!status.authFailed &&
	status.lastSuccessAt === null &&
	status.connectedAt !== null &&
	nowMs - status.connectedAt < SETTLING_WINDOW_MS

/** `errorMessage(exit, fallback)`: the API's own words, or the fallback for an unexpected failure. */
const errorText = (error: unknown, fallback: string): string => {
	const presentation = displayError(error)
	return isUnexpectedError(presentation) ? fallback : presentation.message
}

/** Lists the token's teams, and one team's projects (`forTeam`, or the only team). */
export const DiscoverVercel = Command.define("DiscoverVercel", {
	args: { token: Schema.String, forTeam: Schema.NullOr(Schema.String) },
	messages: [Message.CompletedVercelDiscover],
	execute: ({ token, forTeam }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.vercelDiscover({
				payload:
					forTeam === null
						? new VercelDiscoverRequest({ token })
						: new VercelDiscoverRequest({ token, teamId: forTeam }),
			})
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedVercelDiscover({
						forTeam,
						response: null,
						error: errorText(error, "Vercel didn't accept this token."),
					}),
				onSuccess: (response) => Message.CompletedVercelDiscover({ forTeam, response, error: null }),
			}),
		),
})

/** Connecting and a new token are the same write: the token, the team and what to forward. */
export const ConnectVercel = Command.define("ConnectVercel", {
	args: {
		mode: Schema.Literals(["connect", "token"]),
		token: Schema.String,
		teamId: Schema.String,
		draft: VercelDraftSchema,
	},
	messages: [Message.CompletedVercelConnect],
	execute: ({ mode, token, teamId, draft }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.vercelConnect({
				payload: new VercelConnectRequest({ token, teamId, ...draft }),
			})
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedVercelConnect({
						mode,
						teamName: null,
						error: errorText(
							error,
							mode === "token"
								? "Vercel didn't accept this token."
								: "Couldn't connect Vercel.",
						),
					}),
				onSuccess: (status) =>
					Message.CompletedVercelConnect({
						mode,
						teamName: status.team?.name ?? null,
						error: null,
					}),
			}),
		),
})

/** Saves what the drains forward and re-applies them on Vercel; an empty patch only re-applies. */
export const SaveVercelSettings = Command.define("SaveVercelSettings", {
	args: { request: VercelSettingsRequest, isReapply: Schema.Boolean },
	messages: [Message.CompletedVercelSave],
	execute: ({ request, isReapply }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.vercelSettings({ payload: request })
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedVercelSave({
						isReapply,
						error: errorText(error, "Couldn't update the drains."),
					}),
				onSuccess: () => Message.CompletedVercelSave({ isReapply, error: null }),
			}),
		),
})

export const SyncVercel = Command.define("SyncVercel", {
	messages: [Message.CompletedVercelSync],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		yield* client.integrations.vercelSync()
	}).pipe(
		Effect.match({
			onFailure: (error) => Message.CompletedVercelSync({ failure: toLoadFailure(error) }),
			onSuccess: () => Message.CompletedVercelSync({ failure: null }),
		}),
	),
})
