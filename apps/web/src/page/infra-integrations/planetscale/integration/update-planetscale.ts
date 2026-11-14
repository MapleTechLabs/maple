import type { V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { Option, String as Str, Array as Arr } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import type { Model } from "../../../integrations/model"
import { HubRequest, type ProviderEnv, type ProviderReturn } from "../../../integrations/provider"
import {
	FetchOrganizations,
	isAwaitingFirstMetrics,
	parsePatternList,
	type PlanetscaleCardModel,
	PlanetscaleMessage,
	SelectOrganization,
	SetMetricsToken,
} from "./planetscale"

// The PlanetScale card's state changes, as the PlanetScale module's update.

type Env = ProviderEnv<V2PlanetScaleIntegration>
type Return = ProviderReturn<PlanetscaleCardModel, PlanetscaleMessage>

const withCard = (
	model: PlanetscaleCardModel,
	card: Partial<PlanetscaleCardModel>,
): PlanetscaleCardModel => ({
	...model,
	...card,
})

const statusOf = (env: Pick<Env, "status">): V2PlanetScaleIntegration | null =>
	Option.getOrNull(AsyncData.getData(env.status.data))

/** The page's PlanetScale status, once read. */
export const planetscaleStatusOf = (model: Pick<Model, "statuses">): V2PlanetScaleIntegration | null =>
	Option.getOrNull(AsyncData.getData(model.statuses.planetscale.data))

/** The shown card awaits its first metrics. */
export const isAwaiting = (env: Pick<Env, "status" | "isShown" | "nowMs">): boolean =>
	env.isShown && isAwaitingFirstMetrics(statusOf(env), env.nowMs)

/**
 * The watch starts at the first clock read while the card is shown and awaits first metrics,
 * and resets otherwise, so a later connection or visit gets its own full window.
 */
export const withWatchStart = (
	model: PlanetscaleCardModel,
	env: Env,
	readAtMs: number | null,
): PlanetscaleCardModel =>
	withCard(model, { watchStartedAt: isAwaiting(env) ? (model.watchStartedAt ?? readAtMs) : null })

/** A renewed grant or organization gets its own full window from the next clock read. */
export const restartWatch = (model: PlanetscaleCardModel): Return => ({
	model: withCard(model, { watchStartedAt: null }),
})

/** A status load that starts awaiting first metrics reads the clock to open the window. */
const loadedStatus = (model: PlanetscaleCardModel, env: Env): Return => {
	const watched = withWatchStart(model, env, null)
	return watched.watchStartedAt === null && isAwaiting(env)
		? { model: watched, requests: [HubRequest.readClock()] }
		: { model: watched }
}

/** Each visit to the card starts a fresh watch from a fresh clock. */
export const enterPlanetscale = (model: PlanetscaleCardModel): Return => ({
	model: withCard(model, { watchStartedAt: null }),
	requests: [HubRequest.readClock()],
})

/** A watch tick, or "Check again" after the watch ran out: read the status and the clock. */
const refreshWatch = (model: PlanetscaleCardModel): Return => ({
	model,
	requests: [HubRequest.readStatus("Refresh"), HubRequest.readClock()],
})

/** A write's `planetscaleIntegration` `reactivityKeys` (the target list carries no key). */
const REFRESH_AFTER_WRITE: ReadonlyArray<HubRequest> = [
	HubRequest.readStatus("Supersede"),
	HubRequest.readStatusOf("planetscaleDatabases", "Supersede"),
]

const requestOrganizations = (model: PlanetscaleCardModel, env: Env, mode: Keyed.RequestMode): Return => {
	const key = requestKey(env.context.orgId, "planetscaleIntegration.organizations", {})
	return Option.match(Keyed.request(model.organizations, key, mode), {
		onNone: () => ({ model }),
		onSome: (organizations) => ({
			model: withCard(model, { organizations }),
			commands: [FetchOrganizations({ key })],
		}),
	})
}

/** The picker, seeded once with the saved binding. */
const seededPicker = (env: Env): Partial<PlanetscaleCardModel> => {
	const status = statusOf(env)
	return {
		selectedOrg: status?.organization ?? null,
		includeBranches: Field.init(Arr.join(status?.scrape_target?.include_branches ?? [], ", ")),
		excludeBranches: Field.init(Arr.join(status?.scrape_target?.exclude_branches ?? [], ", ")),
	}
}

/** Once authorized, Choose data's picker reads the organizations; a bound org seeds it once. */
const ensurePicker = (model: PlanetscaleCardModel, env: Env): Return => {
	const status = statusOf(env)
	if (status === null || (!status.connected && !status.pending_org_selection)) return { model }
	const seeded =
		status.connected && model.selectedOrg === null && !model.isSelecting
			? withCard(model, seededPicker(env))
			: model
	return requestOrganizations(seeded, env, "Load")
}

/** The status read answered: the watch window, then the shown card's picker. */
export const statusAnswered = (model: PlanetscaleCardModel, env: Env): Return => {
	const loaded = loadedStatus(model, env)
	if (!env.isShown) return loaded
	const picker = ensurePicker(loaded.model, env)
	return {
		model: picker.model,
		requests: [...(loaded.requests ?? []), ...(picker.requests ?? [])],
		commands: [...(loaded.commands ?? []), ...(picker.commands ?? [])],
	}
}

const dialogCommands = (step: ReturnType<typeof Dialog.update>) =>
	FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		PlanetscaleMessage.GotPickerDialogMessage({ message }),
	)

const dialogStep = (model: PlanetscaleCardModel, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { pickerDialog: step.model }),
	commands: dialogCommands(step),
})

/** "Edit data": the picker dialog, seeded with the current binding. */
const clickedChange = (model: PlanetscaleCardModel, env: Env): Return => {
	const opened = Dialog.open(model.pickerDialog)
	const read = requestOrganizations(
		withCard(model, { ...seededPicker(env), pickerDialog: opened.model }),
		env,
		"Load",
	)
	return { model: read.model, commands: [...dialogCommands(opened), ...(read.commands ?? [])] }
}

const gotPickerDialog = (model: PlanetscaleCardModel, message: Dialog.Message): Return =>
	model.isSelecting ? { model } : dialogStep(model, Dialog.update(model.pickerDialog, message))

const gotBranchField = (
	model: PlanetscaleCardModel,
	field: "include" | "exclude",
	message: Field.Message,
): Return => {
	const step = Field.update(field === "include" ? model.includeBranches : model.excludeBranches, message)
	return {
		model: withCard(
			model,
			field === "include" ? { includeBranches: step.model } : { excludeBranches: step.model },
		),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			PlanetscaleMessage.GotBranchFieldMessage({ field, message: inner }),
		),
	}
}

const clickedPickerCancel = (model: PlanetscaleCardModel): Return =>
	model.pickerDialog.isOpen ? dialogStep(model, Dialog.close(model.pickerDialog)) : { model }

const submittedOrganization = (model: PlanetscaleCardModel): Return => {
	if (model.selectedOrg === null || model.isSelecting) return { model }
	return {
		model: withCard(model, { isSelecting: true }),
		commands: [
			SelectOrganization({
				organization: model.selectedOrg,
				includeBranches: parsePatternList(model.includeBranches.value),
				excludeBranches: parsePatternList(model.excludeBranches.value),
			}),
		],
	}
}

const completedSelect = (
	model: PlanetscaleCardModel,
	env: Env,
	organization: string,
	failure: LoadFailure | null,
): Return => {
	const settled = withCard(model, { isSelecting: false })
	if (failure !== null)
		return {
			model: settled,
			requests: [
				HubRequest.toast("error", "Couldn't connect PlanetScale organization", failure.message),
			],
		}
	const read = requestOrganizations(withCard(settled, { watchStartedAt: null }), env, "Refresh")
	const closed = read.model.pickerDialog.isOpen
		? dialogStep(read.model, Dialog.close(read.model.pickerDialog))
		: { model: read.model }
	return {
		model: closed.model,
		requests: [
			HubRequest.toast("success", `PlanetScale organization ${organization} connected`),
			...REFRESH_AFTER_WRITE,
		],
		commands: [...(read.commands ?? []), ...(closed.commands ?? [])],
	}
}

const gotTokenField = (
	model: PlanetscaleCardModel,
	field: "id" | "secret",
	message: Field.Message,
): Return => {
	const step = Field.update(field === "id" ? model.tokenId : model.tokenSecret, message)
	return {
		model: withCard(model, field === "id" ? { tokenId: step.model } : { tokenSecret: step.model }),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			PlanetscaleMessage.GotTokenField({ field, message: inner }),
		),
	}
}

const submittedToken = (model: PlanetscaleCardModel): Return => {
	const tokenId = Str.trim(model.tokenId.value)
	const tokenSecret = Str.trim(model.tokenSecret.value)
	if (model.isSavingToken || tokenId === "" || tokenSecret === "") return { model }
	return {
		model: withCard(model, { isSavingToken: true, tokenError: null }),
		commands: [SetMetricsToken({ tokenId, tokenSecret })],
	}
}

/** PlanetScale checks the token before Maple stores it, so a failure saved nothing. */
const completedToken = (model: PlanetscaleCardModel, failure: LoadFailure | null): Return =>
	failure !== null
		? { model: withCard(model, { isSavingToken: false, tokenError: failure.message }) }
		: {
				model: withCard(model, {
					isSavingToken: false,
					tokenError: null,
					isReplacingToken: false,
					tokenId: Field.init(),
					tokenSecret: Field.init(),
					watchStartedAt: null,
				}),
				requests: REFRESH_AFTER_WRITE,
			}

export const update = (model: PlanetscaleCardModel, message: PlanetscaleMessage, env: Env): Return =>
	PlanetscaleMessage.match<Return>(message, {
		CompletedFetchOrganizations: ({ key, result }) => ({
			model: withCard(model, { organizations: Keyed.accept(model.organizations, key, result) }),
		}),
		ClickedChangeOrganization: () => clickedChange(model, env),
		GotPickerDialogMessage: ({ message: child }) => gotPickerDialog(model, child),
		SelectedOrganization: ({ name }) => ({ model: withCard(model, { selectedOrg: name }) }),
		GotBranchFieldMessage: ({ field, message: child }) => gotBranchField(model, field, child),
		ClickedPickerCancel: () => clickedPickerCancel(model),
		SubmittedOrganization: () => submittedOrganization(model),
		CompletedSelectOrganization: ({ organization, failure }) =>
			completedSelect(model, env, organization, failure),
		ClickedMetricsDetails: () => ({ model: withCard(model, { isDetailsOpen: !model.isDetailsOpen }) }),
		SelectedMetricsMethod: ({ method }) => ({
			model: withCard(model, { metricsMethod: method, tokenError: null }),
		}),
		GotTokenField: ({ field, message: child }) => gotTokenField(model, field, child),
		SubmittedToken: () => submittedToken(model),
		CompletedToken: ({ failure }) => completedToken(model, failure),
		ClickedReplaceToken: () => ({
			model: withCard(model, { isReplacingToken: !model.isReplacingToken }),
		}),
		TickedWatch: () => refreshWatch(model),
		ClickedCheckAgain: () => refreshWatch(withCard(model, { watchStartedAt: null })),
	})
