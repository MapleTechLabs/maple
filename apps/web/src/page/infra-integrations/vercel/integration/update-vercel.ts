import {
	VercelConnectRequest,
	VercelDiscoverRequest,
	VercelSettingsRequest,
	type VercelDiscoverResponse,
	type VercelIntegrationStatus,
	type VercelProjectScope,
} from "@maple/domain/http"
import { Array as Arr, Option, Record as Rec, Schema } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import {
	DEFAULT_VERCEL_DRAFT,
	draftOf,
	draftProblem,
	settingsPatch,
	stoppedByDraft,
	VERCEL_SAMPLING_RATES,
} from "./vercel-model"
import type { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as RadioGroup from "@maple/views/ui/radio-group"
import type { Model } from "../../../integrations/model"
import { HubRequest, type ProviderEnv, type ProviderReturn } from "../../../integrations/provider"
import {
	ConnectVercel,
	DiscoverVercel,
	initVercelConfigure,
	SaveVercelSettings,
	SyncVercel,
	VercelMessage,
} from "./vercel"
import type {
	VercelCardModel,
	VercelConfigureModel,
	VercelConfigureTarget,
	VercelSignal,
} from "./vercel-schema"

// `VercelIntegrationCard` and `VercelConfigure`'s state changes, as the Vercel module's update.

type Env = ProviderEnv<VercelIntegrationStatus>
type Return = ProviderReturn<VercelCardModel, VercelMessage>

const decodeToken = Schema.decodeUnknownOption(VercelDiscoverRequest)
const decodeConnect = Schema.decodeUnknownOption(VercelConnectRequest)

/** The page's Vercel status, once read. */
export const vercelStatusOf = (model: Pick<Model, "statuses">): VercelIntegrationStatus | null =>
	statusOf(model.statuses.vercel)

const statusOf = (slot: Env["status"]): VercelIntegrationStatus | null =>
	Option.getOrNull(AsyncData.getData(slot.data))

const withCard = (model: VercelCardModel, patch: Partial<VercelCardModel>): VercelCardModel => ({
	...model,
	...patch,
})

const withConfigure = (
	model: VercelCardModel,
	patch: (configure: VercelConfigureModel) => Partial<VercelConfigureModel>,
): VercelCardModel => {
	const configure = model.configure
	return configure === null ? model : withCard(model, { configure: { ...configure, ...patch(configure) } })
}

const isBusy = (configure: VercelConfigureModel): boolean => configure.isLookingUp || configure.isSaving

// SETTLING

/** While a fresh connection settles: the status, and the clock that ends it. */
const tickedSettle = (model: VercelCardModel): Return => ({
	model,
	requests: [HubRequest.readStatus("Refresh"), HubRequest.readClock()],
})

// HEADER ACTIONS AND ISSUE FIXES

const clickedSync = (model: VercelCardModel): Return =>
	model.isSyncing ? { model } : { model: withCard(model, { isSyncing: true }), commands: [SyncVercel()] }

const completedSync = (model: VercelCardModel, failure: LoadFailure | null): Return => {
	const settled = withCard(model, { isSyncing: false })
	return failure === null
		? { model: settled, requests: [HubRequest.readStatus("Refresh")] }
		: { model: settled, requests: [HubRequest.toast("error", "Couldn't sync Vercel", failure.message)] }
}

const clickedReapply = (model: VercelCardModel): Return =>
	model.isReapplying
		? { model }
		: {
				model: withCard(model, { isReapplying: true }),
				commands: [SaveVercelSettings({ request: new VercelSettingsRequest({}), isReapply: true })],
			}

// CONFIGURE

const dialogStep = (model: VercelCardModel, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withConfigure(model, () => ({ dialog: step.model })),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		VercelMessage.GotConfigureDialogMessage({ message }),
	),
})

const confirmStep = (model: VercelCardModel, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withConfigure(model, () => ({ confirm: step.model })),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		VercelMessage.GotConfirmDialogMessage({ message }),
	),
})

const openConfigure = (model: VercelCardModel, env: Env, target: VercelConfigureTarget): Return => {
	const configure = initVercelConfigure(target, statusOf(env.status))
	return dialogStep(withCard(model, { configure }), Dialog.open(configure.dialog))
}

/** The X, Escape and Cancel close the dialog outright, except while a request is out. */
const gotConfigureDialog = (model: VercelCardModel, message: Dialog.Message): Return => {
	const configure = model.configure
	if (configure === null) return { model }
	const step = Dialog.update(configure.dialog, message)
	if (step.model.isOpen) return dialogStep(model, step)
	return isBusy(configure) ? { model } : { model: withCard(model, { configure: null }) }
}

const gotToken = (model: VercelCardModel, message: Field.Message): Return => {
	const configure = model.configure
	if (configure === null) return { model }
	const step = Field.update(configure.token, message)
	return {
		model: withConfigure(model, () => ({ token: step.model })),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			VercelMessage.GotTokenMessage({ message: inner }),
		),
	}
}

/** Connecting looks the token up; a new token for the team is saved with what the drains forward. */
const submittedToken = (model: VercelCardModel, env: Env): Return => {
	const configure = model.configure
	if (configure === null || isBusy(configure)) return { model }
	return Option.match(decodeToken({ token: configure.token.value }), {
		onNone: () => ({ model }),
		onSome: ({ token }) => {
			const status = statusOf(env.status)
			const team = status?.team ?? null
			if (configure.target === "token")
				return status === null || team === null
					? { model }
					: {
							model: withConfigure(model, () => ({ isSaving: true, error: null })),
							commands: [
								ConnectVercel({
									mode: "token",
									token,
									teamId: team.id,
									draft: draftOf(status),
								}),
							],
						}
			return {
				model: withConfigure(model, () => ({ isLookingUp: true, error: null })),
				commands: [DiscoverVercel({ token, forTeam: null })],
			}
		},
	})
}

/**
 * The team is the asked one, or the only one. A fresh token lookup starts from the default settings;
 * re-picking a team after Back keeps them, minus projects the new team doesn't have.
 */
const completedDiscover = (
	model: VercelCardModel,
	forTeam: string | null,
	response: VercelDiscoverResponse | null,
	error: string | null,
): Return => {
	if (error !== null || response === null)
		return { model: withConfigure(model, () => ({ isLookingUp: false, error })) }
	const teams = response.teams
	const team = forTeam ?? (teams.length === 1 ? (teams[0]?.id ?? null) : null)
	const kept = forTeam === null ? null : model.configure?.draft
	const draftFor = (found: VercelDiscoverResponse) => {
		if (kept == null) return DEFAULT_VERCEL_DRAFT
		const ids = new Set(Arr.map(found.projects, (project) => project.id))
		return { ...kept, projectIds: Arr.filter(kept.projectIds, (id) => ids.has(id)) }
	}
	return {
		model: withConfigure(model, () => ({
			isLookingUp: false,
			teams,
			team: RadioGroup.init(team ?? undefined),
			...(team === null
				? {
						projects: null,
						error:
							teams.length === 0
								? "This token can't see any team. Create it with a team scope."
								: null,
					}
				: { projects: response.projects, draft: draftFor(response), projectQuery: "", error: null }),
		})),
	}
}

const gotTeam = (model: VercelCardModel, message: RadioGroup.Message): Return => {
	const configure = model.configure
	if (configure === null) return { model }
	const step = RadioGroup.update(configure.team, message)
	return {
		model: withConfigure(model, () => ({ team: step.model })),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			VercelMessage.GotTeamMessage({ message: inner }),
		),
	}
}

const submittedTeam = (model: VercelCardModel): Return => {
	const configure = model.configure
	const teamId = configure === null ? null : Option.getOrNull(configure.team.maybeValue)
	if (configure === null || teamId === null || isBusy(configure)) return { model }
	return Option.match(decodeToken({ token: configure.token.value }), {
		onNone: () => ({ model }),
		onSome: ({ token }) => ({
			model: withConfigure(model, () => ({ isLookingUp: true, error: null })),
			commands: [DiscoverVercel({ token, forTeam: teamId })],
		}),
	})
}

/** From the settings step to the team step (several teams) or the token; from the team step to the token. */
const clickedBack = (model: VercelCardModel): Return => {
	const configure = model.configure
	if (configure === null || isBusy(configure)) return { model }
	const toToken = { teams: null, team: RadioGroup.init(), projects: null, error: null }
	return {
		model: withConfigure(model, () =>
			configure.projects !== null && (configure.teams?.length ?? 0) > 1
				? { projects: null, error: null }
				: toToken,
		),
	}
}

type Draft = VercelConfigureModel["draft"]

const withDraft = (model: VercelCardModel, patch: (draft: Draft) => Partial<Draft>): Return => ({
	model: withConfigure(model, (configure) => ({
		draft: { ...configure.draft, ...patch(configure.draft) },
	})),
})

const toggledSignal = (model: VercelCardModel, signal: VercelSignal): Return =>
	withDraft(model, (draft) => ({ [signal]: !draft[signal] }))

const changedScope = (model: VercelCardModel, projectScope: VercelProjectScope): Return =>
	withDraft(model, () => ({ projectScope }))

const toggledProject = (model: VercelCardModel, id: string): Return =>
	withDraft(model, (draft) => ({
		projectIds: draft.projectIds.includes(id)
			? Arr.filter(draft.projectIds, (other) => other !== id)
			: [...draft.projectIds, id],
	}))

const changedSampling = (model: VercelCardModel, value: string): Return => {
	return Option.match(
		Arr.findFirst(VERCEL_SAMPLING_RATES, (candidate) => String(candidate) === value),
		{ onNone: () => ({ model }), onSome: (rate) => withDraft(model, () => ({ samplingRate: rate })) },
	)
}

const changedProjectQuery = (model: VercelCardModel, projectQuery: string): Return => ({
	model: withConfigure(model, () => ({ projectQuery })),
})

const submittedConnect = (model: VercelCardModel): Return => {
	const configure = model.configure
	const teamId = configure === null ? null : Option.getOrNull(configure.team.maybeValue)
	if (configure === null || teamId === null || isBusy(configure) || draftProblem(configure.draft) !== null)
		return { model }
	return Option.match(decodeConnect({ token: configure.token.value, teamId, ...configure.draft }), {
		onNone: () => ({ model }),
		onSome: (request) => ({
			model: withConfigure(model, () => ({ isSaving: true, error: null })),
			commands: [
				ConnectVercel({
					mode: "connect",
					token: request.token,
					teamId: request.teamId,
					draft: configure.draft,
				}),
			],
		}),
	})
}

/** A refusal stays in the dialog; a connection closes it, toasts and re-reads the status. */
const completedConnect = (
	model: VercelCardModel,
	mode: "connect" | "token",
	teamName: string | null,
	error: string | null,
): Return => {
	if (error !== null) return { model: withConfigure(model, () => ({ isSaving: false, error })) }
	return {
		model: withCard(model, { configure: null }),
		requests: [
			mode === "token"
				? HubRequest.toast("success", "Vercel token updated")
				: HubRequest.toast(
						"success",
						`Connected ${teamName ?? "Vercel"}`,
						"Vercel starts delivering within a minute.",
					),
			HubRequest.readStatus("Refresh"),
		],
	}
}

/** The settings as saved, and what the draft would change. */
export const settingsChange = (status: VercelIntegrationStatus, configure: VercelConfigureModel) => {
	const saved = draftOf(status)
	const patch = settingsPatch(saved, configure.draft)
	return {
		patch,
		isChanged: Rec.size<string, unknown>(patch) > 0,
		problem: draftProblem(configure.draft),
		stops: stoppedByDraft(
			saved,
			configure.draft,
			new Map(Arr.map(status.projects, (project) => [project.id, project.name])),
		),
	}
}

const save = (model: VercelCardModel, env: Env): Return => {
	const configure = model.configure
	const status = statusOf(env.status)
	if (configure === null || status === null || configure.isSaving) return { model }
	return {
		model: withConfigure(model, () => ({ isSaving: true, error: null })),
		commands: [
			SaveVercelSettings({
				request: new VercelSettingsRequest(settingsChange(status, configure).patch),
				isReapply: false,
			}),
		],
	}
}

/** Forwarding less asks first; anything else applies on Vercel at once. */
const clickedSave = (model: VercelCardModel, env: Env): Return => {
	const configure = model.configure
	const status = statusOf(env.status)
	if (configure === null || status === null || configure.isSaving) return { model }
	const change = settingsChange(status, configure)
	if (!change.isChanged || change.problem !== null) return { model }
	return change.stops.length > 0 ? confirmStep(model, Dialog.open(configure.confirm)) : save(model, env)
}

const gotConfirmDialog = (model: VercelCardModel, message: Dialog.Message): Return => {
	const configure = model.configure
	if (configure === null || configure.isSaving) return { model }
	return confirmStep(model, Dialog.update(configure.confirm, message))
}

/** A re-apply only toasts; a settings save closes the dialog, or shows Vercel's refusal in it. */
const completedSave = (model: VercelCardModel, isReapply: boolean, error: string | null): Return => {
	if (isReapply) {
		const settled = withCard(model, { isReapplying: false })
		return error === null
			? {
					model: settled,
					requests: [
						HubRequest.toast("success", "Drains re-applied on Vercel"),
						HubRequest.readStatus("Refresh"),
					],
				}
			: { model: settled, requests: [HubRequest.toast("error", "Couldn't re-apply the drains", error)] }
	}
	const configure = model.configure
	if (error !== null && configure !== null)
		return confirmStep(
			withConfigure(model, () => ({ isSaving: false, error })),
			Dialog.close(configure.confirm),
		)
	return {
		model: withCard(model, { configure: null }),
		requests: [
			...(error === null ? [HubRequest.toast("success", "Drains updated on Vercel")] : []),
			HubRequest.readStatus("Refresh"),
		],
	}
}

export const update = (model: VercelCardModel, message: VercelMessage, env: Env): Return =>
	VercelMessage.match<Return>(message, {
		TickedSettle: () => tickedSettle(model),
		ClickedSync: () => clickedSync(model),
		CompletedSync: ({ failure }) => completedSync(model, failure),
		ClickedReapply: () => clickedReapply(model),
		ClickedConfigure: ({ target }) => openConfigure(model, env, target),
		GotConfigureDialogMessage: ({ message: child }) => gotConfigureDialog(model, child),
		GotTokenMessage: ({ message: child }) => gotToken(model, child),
		SubmittedToken: () => submittedToken(model, env),
		CompletedDiscover: ({ forTeam, response, error }) =>
			completedDiscover(model, forTeam, response, error),
		GotTeamMessage: ({ message: child }) => gotTeam(model, child),
		SubmittedTeam: () => submittedTeam(model),
		ClickedConfigureBack: () => clickedBack(model),
		ToggledSignal: ({ signal }) => toggledSignal(model, signal),
		ChangedScope: ({ scope }) => changedScope(model, scope),
		ToggledProject: ({ id }) => toggledProject(model, id),
		ChangedProjectQuery: ({ value }) => changedProjectQuery(model, value),
		ChangedSampling: ({ value }) => changedSampling(model, value),
		SubmittedConnect: () => submittedConnect(model),
		CompletedConnect: ({ mode, teamName, error }) => completedConnect(model, mode, teamName, error),
		ClickedSave: () => clickedSave(model, env),
		GotConfirmDialogMessage: ({ message: child }) => gotConfirmDialog(model, child),
		ConfirmedSave: () => save(model, env),
		CompletedSave: ({ isReapply, error }) => completedSave(model, isReapply, error),
	})
