import {
	VercelConnectRequest,
	VercelDiscoverRequest,
	VercelSettingsRequest,
	type VercelDiscoverResponse,
	type VercelIntegrationStatus,
	type VercelProjectScope,
} from "@maple/domain/http"
import { Option, Schema } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import {
	DEFAULT_VERCEL_DRAFT,
	draftOf,
	draftProblem,
	settingsPatch,
	stoppedByDraft,
	VERCEL_SAMPLING_RATES,
} from "../../components/integrations/vercel-model"
import * as Keyed from "../../data/keyed"
import type { LoadFailure } from "../../data/load-failure"
import { requestKey } from "../../data/request-key"
import * as Dialog from "../../ui/dialog"
import * as Field from "../../ui/field"
import * as RadioGroup from "../../ui/radio-group"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { integrationOfSearch } from "./catalog"
import { ReadClock } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { chain, requestStatus } from "./update-status"
import {
	ConnectVercel,
	DiscoverVercel,
	initVercelConfigure,
	LoadVercelGateway,
	LoadVercelProjects,
	LoadVercelTimeseries,
	SaveVercelSettings,
	SyncVercel,
	VERCEL_DAY,
	VERCEL_DAY_HOURLY,
} from "./vercel"
import type {
	VercelCardModel,
	VercelConfigureModel,
	VercelConfigureTarget,
	VercelSignal,
} from "./vercel-schema"

// `VercelIntegrationCard` and `VercelConfigure`'s state changes.

type Return = PageReturn<Model, Message>

const decodeToken = Schema.decodeUnknownOption(VercelDiscoverRequest)
const decodeConnect = Schema.decodeUnknownOption(VercelConnectRequest)

export const vercelStatusOf = (model: Model): VercelIntegrationStatus | null =>
	Option.getOrNull(AsyncData.getData(model.statuses.vercel.data))

export const withVercelCard = (model: Model, patch: Partial<VercelCardModel>): Model => ({
	...model,
	vercelCard: { ...model.vercelCard, ...patch },
})

const withConfigure = (
	model: Model,
	patch: (configure: VercelConfigureModel) => Partial<VercelConfigureModel>,
): Model => {
	const configure = model.vercelCard.configure
	return configure === null ? model : withVercelCard(model, { configure: { ...configure, ...patch(configure) } })
}

const toast = (
	model: Model,
	type: "success" | "error",
	title: string,
	description = "",
): Return => ({ model, outMessage: PageOutMessage.RequestedToast({ type, title, description }) })

const isBusy = (configure: VercelConfigureModel): boolean => configure.isLookingUp || configure.isSaving

// THE LAST 24 HOURS

/** The three reads, each asked once per mode like `useAtomValue` + `useAtomRefresh`. */
export const requestUsage = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const projectsKey = requestKey(context.orgId, "getVercelProjects", { data: VERCEL_DAY })
	const timeseriesKey = requestKey(context.orgId, "getVercelRequestTimeseries", { data: VERCEL_DAY_HOURLY })
	const gatewayKey = requestKey(context.orgId, "getVercelAiGateway", { data: VERCEL_DAY_HOURLY })
	return chain(model, [
		(next) =>
			Option.match(Keyed.request(next.vercelCard.projects, projectsKey, mode), {
				onNone: () => ({ model: next }),
				onSome: (projects) => ({
					model: withVercelCard(next, { projects }),
					commands: [LoadVercelProjects({ key: projectsKey })],
				}),
			}),
		(next) =>
			Option.match(Keyed.request(next.vercelCard.timeseries, timeseriesKey, mode), {
				onNone: () => ({ model: next }),
				onSome: (timeseries) => ({
					model: withVercelCard(next, { timeseries }),
					commands: [LoadVercelTimeseries({ key: timeseriesKey })],
				}),
			}),
		(next) =>
			Option.match(Keyed.request(next.vercelCard.gateway, gatewayKey, mode), {
				onNone: () => ({ model: next }),
				onSome: (gateway) => ({
					model: withVercelCard(next, { gateway }),
					commands: [LoadVercelGateway({ key: gatewayKey })],
				}),
			}),
	])
}

/** The warehouse is read only once the Vercel page shows a connected team. */
export const enterVercel = (model: Model, context: PageContext): Return =>
	integrationOfSearch(model.search.integration) === "vercel" && vercelStatusOf(model)?.connected === true
		? requestUsage(model, context, "Load")
		: { model }

/** While a fresh connection settles: the status, the last 24 hours and the clock that ends it. */
export const tickedSettle = (model: Model, context: PageContext): Return =>
	chain(model, [
		(next) => requestStatus(next, context, "vercel", "Poll"),
		(next) => requestUsage(next, context, "Refresh"),
		(next) => ({ model: next, commands: [ReadClock()] }),
	])

// HEADER ACTIONS AND ISSUE FIXES

export const clickedSync = (model: Model): Return =>
	model.vercelCard.isSyncing
		? { model }
		: { model: withVercelCard(model, { isSyncing: true }), commands: [SyncVercel()] }

export const completedSync = (model: Model, context: PageContext, failure: LoadFailure | null): Return => {
	const settled = withVercelCard(model, { isSyncing: false })
	return failure === null
		? requestStatus(settled, context, "vercel", "Refresh")
		: toast(settled, "error", "Failed to sync Vercel", failure.message)
}

export const clickedReapply = (model: Model): Return =>
	model.vercelCard.isReapplying
		? { model }
		: {
				model: withVercelCard(model, { isReapplying: true }),
				commands: [SaveVercelSettings({ request: new VercelSettingsRequest({}), isReapply: true })],
			}

// CONFIGURE

const dialogStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withConfigure(model, () => ({ dialog: step.model })),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotVercelConfigureDialogMessage({ message }),
	),
})

const confirmStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withConfigure(model, () => ({ confirm: step.model })),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotVercelConfirmDialogMessage({ message }),
	),
})

export const openConfigure = (model: Model, target: VercelConfigureTarget): Return => {
	const configure = initVercelConfigure(target, vercelStatusOf(model))
	return dialogStep(withVercelCard(model, { configure }), Dialog.open(configure.dialog))
}

/** The X, Escape and Cancel close the dialog outright, except while a request is out. */
export const gotConfigureDialog = (model: Model, message: Dialog.Message): Return => {
	const configure = model.vercelCard.configure
	if (configure === null) return { model }
	const step = Dialog.update(configure.dialog, message)
	if (step.model.isOpen) return dialogStep(model, step)
	return isBusy(configure) ? { model } : { model: withVercelCard(model, { configure: null }) }
}

export const gotToken = (model: Model, message: Field.Message): Return => {
	const configure = model.vercelCard.configure
	if (configure === null) return { model }
	const step = Field.update(configure.token, message)
	return {
		model: withConfigure(model, () => ({ token: step.model })),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			Message.GotVercelTokenMessage({ message: inner }),
		),
	}
}

/** Connecting looks the token up; a new token for the team is saved with what the drains forward. */
export const submittedToken = (model: Model): Return => {
	const configure = model.vercelCard.configure
	if (configure === null || isBusy(configure)) return { model }
	return Option.match(decodeToken({ token: configure.token.value }), {
		onNone: () => ({ model }),
		onSome: ({ token }) => {
			const status = vercelStatusOf(model)
			const team = status?.team ?? null
			if (configure.target === "token")
				return status === null || team === null
					? { model }
					: {
							model: withConfigure(model, () => ({ isSaving: true, error: null })),
							commands: [ConnectVercel({ mode: "token", token, teamId: team.id, draft: draftOf(status) })],
						}
			return {
				model: withConfigure(model, () => ({ isLookingUp: true, error: null })),
				commands: [DiscoverVercel({ token, forTeam: null })],
			}
		},
	})
}

/** A pick made for an earlier lookup never carries over: the team is the asked one, or the only one. */
export const completedDiscover = (
	model: Model,
	forTeam: string | null,
	response: VercelDiscoverResponse | null,
	error: string | null,
): Return => {
	if (error !== null || response === null)
		return { model: withConfigure(model, () => ({ isLookingUp: false, error })) }
	const teams = response.teams
	const team = forTeam ?? (teams.length === 1 ? (teams[0]?.id ?? null) : null)
	return {
		model: withConfigure(model, () => ({
			isLookingUp: false,
			teams,
			team: RadioGroup.init(team ?? undefined),
			...(team === null
				? {
						projects: null,
						error: teams.length === 0 ? "This token can't see any team. Create it with a team scope." : null,
					}
				: { projects: response.projects, draft: DEFAULT_VERCEL_DRAFT, projectQuery: "", error: null }),
		})),
	}
}

export const gotTeam = (model: Model, message: RadioGroup.Message): Return => {
	const configure = model.vercelCard.configure
	if (configure === null) return { model }
	const step = RadioGroup.update(configure.team, message)
	return {
		model: withConfigure(model, () => ({ team: step.model })),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			Message.GotVercelTeamMessage({ message: inner }),
		),
	}
}

export const submittedTeam = (model: Model): Return => {
	const configure = model.vercelCard.configure
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
export const clickedBack = (model: Model): Return => {
	const configure = model.vercelCard.configure
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

const withDraft = (model: Model, patch: (draft: Draft) => Partial<Draft>): Return => ({
	model: withConfigure(model, (configure) => ({ draft: { ...configure.draft, ...patch(configure.draft) } })),
})

export const toggledSignal = (model: Model, signal: VercelSignal): Return =>
	withDraft(model, (draft) => ({ [signal]: !draft[signal] }))

export const changedScope = (model: Model, projectScope: VercelProjectScope): Return =>
	withDraft(model, () => ({ projectScope }))

export const toggledProject = (model: Model, id: string): Return =>
	withDraft(model, (draft) => ({
		projectIds: draft.projectIds.includes(id)
			? draft.projectIds.filter((other) => other !== id)
			: [...draft.projectIds, id],
	}))

export const changedSampling = (model: Model, value: string): Return => {
	const rate = VERCEL_SAMPLING_RATES.find((candidate) => String(candidate) === value)
	return rate === undefined ? { model } : withDraft(model, () => ({ samplingRate: rate }))
}

export const changedProjectQuery = (model: Model, projectQuery: string): Return => ({
	model: withConfigure(model, () => ({ projectQuery })),
})

export const submittedConnect = (model: Model): Return => {
	const configure = model.vercelCard.configure
	const teamId = configure === null ? null : Option.getOrNull(configure.team.maybeValue)
	if (configure === null || teamId === null || isBusy(configure) || draftProblem(configure.draft) !== null)
		return { model }
	return Option.match(decodeConnect({ token: configure.token.value, teamId, ...configure.draft }), {
		onNone: () => ({ model }),
		onSome: (request) => ({
			model: withConfigure(model, () => ({ isSaving: true, error: null })),
			commands: [
				ConnectVercel({ mode: "connect", token: request.token, teamId: request.teamId, draft: configure.draft }),
			],
		}),
	})
}

/** A refusal stays in the dialog; a connection closes it, toasts and re-reads the status. */
export const completedConnect = (
	model: Model,
	context: PageContext,
	mode: "connect" | "token",
	teamName: string | null,
	error: string | null,
): Return => {
	if (error !== null) return { model: withConfigure(model, () => ({ isSaving: false, error })) }
	return chain(withVercelCard(model, { configure: null }), [
		(next) =>
			mode === "token"
				? toast(next, "success", "Vercel token updated")
				: toast(next, "success", `Connected ${teamName ?? "Vercel"}`, "Vercel starts delivering within a minute."),
		(next) => requestStatus(next, context, "vercel", "Refresh"),
	])
}

/** The settings as saved, and what the draft would change. */
export const settingsChange = (status: VercelIntegrationStatus, configure: VercelConfigureModel) => {
	const saved = draftOf(status)
	const patch = settingsPatch(saved, configure.draft)
	return {
		patch,
		isChanged: Object.keys(patch).length > 0,
		problem: draftProblem(configure.draft),
		stops: stoppedByDraft(
			saved,
			configure.draft,
			new Map(status.projects.map((project) => [project.id, project.name])),
		),
	}
}

const save = (model: Model): Return => {
	const configure = model.vercelCard.configure
	const status = vercelStatusOf(model)
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
export const clickedSave = (model: Model): Return => {
	const configure = model.vercelCard.configure
	const status = vercelStatusOf(model)
	if (configure === null || status === null || configure.isSaving) return { model }
	const change = settingsChange(status, configure)
	if (!change.isChanged || change.problem !== null) return { model }
	return change.stops.length > 0 ? confirmStep(model, Dialog.open(configure.confirm)) : save(model)
}

export const confirmedSave = save

export const gotConfirmDialog = (model: Model, message: Dialog.Message): Return => {
	const configure = model.vercelCard.configure
	if (configure === null || configure.isSaving) return { model }
	return confirmStep(model, Dialog.update(configure.confirm, message))
}

/** A re-apply only toasts; a settings save closes the dialog, or shows Vercel's refusal in it. */
export const completedSave = (
	model: Model,
	context: PageContext,
	isReapply: boolean,
	error: string | null,
): Return => {
	if (isReapply) {
		const settled = withVercelCard(model, { isReapplying: false })
		return error === null
			? chain(settled, [
					(next) => toast(next, "success", "Drains re-applied on Vercel"),
					(next) => requestStatus(next, context, "vercel", "Refresh"),
				])
			: toast(settled, "error", "Failed to re-apply the drains", error)
	}
	const configure = model.vercelCard.configure
	if (error !== null && configure !== null)
		return confirmStep(withConfigure(model, () => ({ isSaving: false, error })), Dialog.close(configure.confirm))
	return chain(withVercelCard(model, { configure: null }), [
		(next) => (error === null ? toast(next, "success", "Drains updated on Vercel") : { model: next }),
		(next) => requestStatus(next, context, "vercel", "Refresh"),
	])
}
