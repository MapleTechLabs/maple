import type { V2ChatConnectorList } from "@maple/domain/http/v2"
import type { ChatWorkspaceId } from "@maple/primitives"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import { chatConnectorOf, chatManifestOf } from "./catalog"
import {
	type ChatCardModel,
	type ChatFeatureFlag,
	ChatMessage,
	SaveChatFeatures,
	savedChatFeatures,
	connectorStatusOf,
	DisconnectChatWorkspace,
	InstallChat,
	LinkChatIdentity,
	UnlinkChatIdentity,
} from "./chat"
import { disconnectSpec } from "./disconnect"
import { completedSwitches, initFeatureSwitches, settledSwitches, toggledSwitches } from "./feature-switches"
import { HubRequest, type ProviderEnv, type ProviderReturn, type StatusAnswer } from "./provider"

type Env = ProviderEnv<V2ChatConnectorList>
type Return = ProviderReturn<ChatCardModel, ChatMessage>

const connectorOfPage = (env: Env) => (env.integration === null ? null : chatConnectorOf(env.integration))

const platformOf = (env: Env) => {
	const connector = connectorOfPage(env)
	return connector === null ? "" : (chatManifestOf(connector)?.name ?? "")
}

/** A success title (optional) and the connectors re-read, or the error title with the failure's message. */
const outcomeRequests = (
	failure: LoadFailure | null,
	titles: Readonly<{ success?: string; error: string }>,
): ReadonlyArray<HubRequest> =>
	failure === null
		? [
				...(titles.success === undefined ? [] : [HubRequest.toast("success", titles.success)]),
				HubRequest.readStatus("Supersede"),
			]
		: [HubRequest.toast("error", titles.error, failure.message)]

const clickedInstall = (model: ChatCardModel, env: Env): Return => {
	const connector = connectorOfPage(env)
	if (connector === null || model.busy !== null) return { model }
	return { model: { ...model, busy: "install" }, commands: [InstallChat({ connector })] }
}

/** Success keeps the card busy: the browser is already leaving for the platform. */
const completedInstall = (model: ChatCardModel, env: Env, failure: LoadFailure | null): Return =>
	failure === null
		? { model, requests: [HubRequest.readStatus("Supersede")] }
		: {
				model: { ...model, busy: null },
				requests: outcomeRequests(failure, {
					error: `Couldn't start the ${platformOf(env)} install`,
				}),
			}

const clickedIdentity = (model: ChatCardModel, env: Env): Return => {
	const connector = connectorOfPage(env)
	const status = connectorStatusOf(env.status, connector)
	if (connector === null || model.identityBusy) return { model }
	return {
		model: { ...model, identityBusy: true },
		commands: [
			status?.identity === undefined
				? LinkChatIdentity({ connector })
				: UnlinkChatIdentity({ connector }),
		],
	}
}

const completedIdentity = (
	model: ChatCardModel,
	kind: "link" | "unlink",
	failure: LoadFailure | null,
): Return =>
	kind === "link" && failure === null
		? { model, requests: [HubRequest.readStatus("Supersede")] }
		: {
				model: { ...model, identityBusy: false },
				requests: outcomeRequests(
					failure,
					kind === "link"
						? { error: "Couldn't start the account link" }
						: { success: "Account unlinked", error: "Couldn't unlink the account" },
				),
			}

const clickedDisconnect = (model: ChatCardModel, workspaceId: ChatWorkspaceId): Return => ({
	model: { ...model, confirmId: workspaceId },
	requests: [HubRequest.openDisconnect()],
})

/** The shared dialog's confirm: it stays open, pending, until the workspace is gone. */
export const confirmedDisconnect = (model: ChatCardModel): Return => {
	const id = model.confirmId
	if (id === null || model.busy !== null) return { model }
	return { model: { ...model, busy: id }, commands: [DisconnectChatWorkspace({ id })] }
}

const completedDisconnect = (model: ChatCardModel, env: Env, failure: LoadFailure | null): Return => {
	const connector = connectorOfPage(env)
	return {
		model: { ...model, busy: null, confirmId: null },
		requests: [
			HubRequest.closeDisconnect(),
			...outcomeRequests(failure, disconnectSpec("chat")),
			...(failure === null && connector !== null ? [HubRequest.trackDisconnected(connector)] : []),
		],
	}
}

/** The workspace removal is in flight: the shared dialog ignores its own messages meanwhile. */
export const isDisconnecting = (model: ChatCardModel): boolean =>
	model.busy !== null && model.busy === model.confirmId

/** A workspace's switch flips on screen at once and saves; a second toggle waits for the first save. */
const toggledFeature = (
	model: ChatCardModel,
	env: Env,
	workspaceId: ChatWorkspaceId,
	flag: typeof ChatFeatureFlag.Type,
): Return => {
	const workspace = Option.getOrNull(
		Option.flatMap(AsyncData.getData(env.status.data), (response) =>
			Arr.findFirst(
				Arr.flatMap(response.data, (entry) => entry.workspaces),
				(candidate) => candidate.id === workspaceId,
			),
		),
	)
	if (workspace === null || model.features.isSaving) return { model }
	// Another workspace's draft or error does not carry over to this one.
	const state = model.featuresWorkspaceId === workspaceId ? model.features : initFeatureSwitches
	const step = toggledSwitches(state, savedChatFeatures(workspace), (switches) => ({
		...switches,
		[flag]: !switches[flag],
	}))
	return {
		model: { ...model, features: step.state, featuresWorkspaceId: workspaceId },
		commands:
			step.save === null ? [] : [SaveChatFeatures({ id: workspaceId, flag, enabled: step.save[flag] })],
	}
}

/** Only the current answer settles the switches: a superseded read predates the save. */
export const statusAnswered = (
	model: ChatCardModel,
	_env: Env,
	answer: StatusAnswer<V2ChatConnectorList>,
): Return => ({ model: answer.isCurrent ? { ...model, features: settledSwitches(model.features) } : model })

export const update = (model: ChatCardModel, message: ChatMessage, env: Env): Return =>
	ChatMessage.match<Return>(message, {
		ClickedInstall: () => clickedInstall(model, env),
		CompletedInstall: ({ failure }) => completedInstall(model, env, failure),
		ClickedIdentity: () => clickedIdentity(model, env),
		CompletedIdentity: ({ kind, failure }) => completedIdentity(model, kind, failure),
		ClickedDisconnect: ({ workspaceId }) => clickedDisconnect(model, workspaceId),
		CompletedDisconnect: ({ failure }) => completedDisconnect(model, env, failure),
		ToggledFeature: ({ workspaceId, flag }) => toggledFeature(model, env, workspaceId, flag),
		CompletedFeatures: ({ failure }) => ({
			model: { ...model, features: completedSwitches(model.features, failure?.message ?? null) },
			requests: [HubRequest.readStatus("Supersede")],
		}),
	})
