import {
	VercelDiscoverResponse,
	VercelDrainStatus,
	VercelInfraProjectsResponse,
	VercelInfraRequestTimeseriesResponse,
	VercelIntegrationStatus,
	VercelTeam,
} from "@maple/domain/http"
import { Schema } from "effect"
import { AsyncData, Command, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { toLoadFailure } from "../data/load-failure"
import { Message as IntegrationsMessage } from "../page/integrations/message"
import { Model as IntegrationsModel } from "../page/integrations/model"
import * as Integrations from "../page/integrations/update"
import { vercelCard } from "../page/integrations/view-vercel"
import { vercelConfigure } from "../page/integrations/view-vercel-configure"
import { dashboardPage } from "../page/kit/dashboard-page"
import type { Resources } from "../platform/resources"
import { button } from "../ui/button"
import * as Field from "../ui/field"
import * as RadioGroup from "../ui/radio-group"
import { type GcpLabFlags, LAB_CONTEXT } from "./gcp-host"
import {
	VERCEL_AI_GATEWAY,
	VERCEL_BUCKETS,
	VERCEL_EMPTY_AI_GATEWAY,
	VERCEL_PROJECTS,
	VERCEL_READ_FAILURE,
	VERCEL_STATUS,
} from "./vercel-infra-fixtures"

// `/lab/vercel`: the Vercel card in each state, over fixtures, as an admin sees it. Each section
// hosts its own integrations Model; the page's reads are never sent and its writes are answered here.

type HubCommand = Command.Command<IntegrationsMessage, never, Resources>

const LABS = new VercelTeam({ id: "team_labs", slug: "acme-labs", name: "Acme Labs" })
const TEAMS = [VERCEL_STATUS.team ?? LABS, LABS]
const PICKABLE = VERCEL_STATUS.projects.map(({ id, name, framework }) => ({ id, name, framework }))

const drain = (status: VercelDrainStatus["status"], id: string | null, lastError: string | null = null) =>
	new VercelDrainStatus({ id, status, lastError })

const NOT_CONNECTED = new VercelIntegrationStatus({
	...VERCEL_STATUS,
	connected: false,
	team: null,
	drains: { logs: null, traces: null },
	projects: [],
	connectedAt: null,
	lastSuccessAt: null,
})

type Usage = "loaded" | "empty" | "failed"
type Scene = Readonly<{ id: string; title: string; status: VercelIntegrationStatus; usage: Usage }>

const scenesAt = (nowMs: number): ReadonlyArray<Scene> => [
	{ id: "not-connected", title: "Not connected", status: NOT_CONNECTED, usage: "empty" },
	{ id: "connect", title: "Connect dialog steps", status: NOT_CONNECTED, usage: "empty" },
	{ id: "healthy", title: "Connected, healthy", status: VERCEL_STATUS, usage: "loaded" },
	{
		id: "logs-deleted",
		title: "Logs drain deleted on Vercel",
		status: new VercelIntegrationStatus({
			...VERCEL_STATUS,
			drains: { ...VERCEL_STATUS.drains, logs: drain("missing", null) },
		}),
		usage: "loaded",
	},
	{
		id: "traces-failing",
		title: "Traces drain failing",
		status: new VercelIntegrationStatus({
			...VERCEL_STATUS,
			drains: {
				...VERCEL_STATUS.drains,
				traces: drain("errored", "drn_traces", "401 Unauthorized: the ingest key was rejected."),
			},
		}),
		usage: "loaded",
	},
	{
		id: "token-rejected",
		title: "Token rejected",
		status: new VercelIntegrationStatus({ ...VERCEL_STATUS, authFailed: true }),
		usage: "loaded",
	},
	{
		id: "first-sync",
		title: "First sync pending",
		status: new VercelIntegrationStatus({
			...VERCEL_STATUS,
			drains: { logs: drain("unknown", "drn_logs"), traces: drain("unknown", "drn_traces") },
			projects: [],
			connectedAt: nowMs - 2 * 60_000,
			lastSuccessAt: null,
		}),
		usage: "empty",
	},
	{ id: "usage-failed", title: "Usage reads failed", status: VERCEL_STATUS, usage: "failed" },
]

const success = <A>(data: A) => ({ key: null, data: AsyncData.Success({ data }) })
const FAILED = { key: null, data: AsyncData.Failure({ error: toLoadFailure(VERCEL_READ_FAILURE) }) }

/** The page's Model with this scene's status and last 24 hours loaded, never requested. */
const hubOf = (nowMs: number, scene: Scene): IntegrationsModel => {
	const hub = Integrations.init({ search: { integration: "vercel" } }, LAB_CONTEXT).model
	const empty = scene.usage === "empty"
	return {
		...hub,
		nowMs,
		isAdmin: true,
		statuses: { ...hub.statuses, vercel: success(scene.status) },
		vercelCard: {
			...hub.vercelCard,
			...(scene.usage === "failed"
				? { projects: FAILED, timeseries: FAILED, gateway: FAILED }
				: {
						projects: success(new VercelInfraProjectsResponse({ projects: empty ? [] : VERCEL_PROJECTS })),
						timeseries: success(new VercelInfraRequestTimeseriesResponse({ buckets: empty ? [] : VERCEL_BUCKETS })),
						gateway: success(empty ? VERCEL_EMPTY_AI_GATEWAY : VERCEL_AI_GATEWAY),
					}),
		},
	}
}

/** Reads the page owns but the lab does not serve: statuses, the clock, the last 24 hours. */
const PAGE_READS = /^(LoadIntegrations|LoadVercel|ReadIntegrationsClock)/

const stringArg = (command: HubCommand, name: string): string | null => {
	const value = command.args?.[name]
	return typeof value === "string" ? value : null
}

/** The writes, answered as Vercel would accept them; the lookup lists two teams, then the projects. */
const answerOf = (command: HubCommand): IntegrationsMessage | null => {
	switch (command.name) {
		case "DiscoverVercel": {
			const forTeam = stringArg(command, "forTeam")
			return IntegrationsMessage.CompletedVercelDiscover({
				forTeam,
				response: new VercelDiscoverResponse({ teams: TEAMS, projects: forTeam === null ? [] : PICKABLE }),
				error: null,
			})
		}
		case "ConnectVercel":
			return IntegrationsMessage.CompletedVercelConnect({
				mode: stringArg(command, "mode") === "token" ? "token" : "connect",
				teamName: "Acme",
				error: null,
			})
		case "SaveVercelSettings":
			return IntegrationsMessage.CompletedVercelSave({ isReapply: command.args?.["isReapply"] === true, error: null })
		case "SyncVercel":
			return IntegrationsMessage.CompletedVercelSync({ failure: null })
		case "DisconnectIntegration":
			return IntegrationsMessage.CompletedDisconnect({ integration: "vercel", failure: null })
		default:
			return null
	}
}

type HubStep = Readonly<{ hub: IntegrationsModel; commands: ReadonlyArray<HubCommand> }>

/** The page's own update; reads are dropped, writes answered at once, the rest (dialog motion) run. */
export const hubStep = (hub: IntegrationsModel, message: IntegrationsMessage): HubStep => {
	const next = Integrations.update(hub, message, LAB_CONTEXT)
	return (next.commands ?? []).reduce<HubStep>(
		(acc, command) => {
			if (PAGE_READS.test(command.name)) return acc
			const answer = answerOf(command)
			if (answer === null) return { ...acc, commands: [...acc.commands, command] }
			const answered = hubStep(acc.hub, answer)
			return { hub: answered.hub, commands: [...acc.commands, ...answered.commands] }
		},
		{ hub: next.model, commands: [] },
	)
}

const hubSteps = (hub: IntegrationsModel, messages: ReadonlyArray<IntegrationsMessage>): HubStep =>
	messages.reduce<HubStep>(
		(acc, message) => {
			const next = hubStep(acc.hub, message)
			return { hub: next.hub, commands: [...acc.commands, ...next.commands] }
		},
		{ hub, commands: [] },
	)

export const ConnectStep = Schema.Literals(["token", "team", "settings", "refused"])
export type ConnectStep = typeof ConnectStep.Type

const STEP_BUTTONS: ReadonlyArray<Readonly<{ step: ConnectStep; label: string }>> = [
	{ step: "token", label: "Open token step" },
	{ step: "team", label: "Open team step" },
	{ step: "settings", label: "Open settings step" },
	{ step: "refused", label: "Open token refused" },
]

const typedToken = [
	IntegrationsMessage.ClickedVercelConfigure({ target: "connect" }),
	IntegrationsMessage.GotVercelTokenMessage({
		message: Field.Message.ChangedValue({ value: "vc_lab_token_0001" }),
	}),
]

/** Each step as the admin reaches it: the token typed, the lookup answered, the team and settings picked. */
const STEP_MESSAGES = {
	token: typedToken,
	team: [...typedToken, IntegrationsMessage.SubmittedVercelToken()],
	settings: [
		...typedToken,
		IntegrationsMessage.SubmittedVercelToken(),
		IntegrationsMessage.GotVercelTeamMessage({
			message: RadioGroup.Message.SelectedRadio({ value: TEAMS[0]?.id ?? "" }),
		}),
		IntegrationsMessage.SubmittedVercelTeam(),
		IntegrationsMessage.ChangedVercelScope({ scope: "some" }),
		IntegrationsMessage.ToggledVercelProject({ id: "prj_storefront" }),
		IntegrationsMessage.ToggledVercelProject({ id: "prj_api" }),
		IntegrationsMessage.ChangedVercelSampling({ value: "0.25" }),
	],
	refused: [
		...typedToken,
		// The lookup is not sent: Vercel's refusal arrives as its answer.
		IntegrationsMessage.CompletedVercelDiscover({
			forTeam: null,
			response: null,
			error: "Vercel rejected the token: it has expired or was revoked.",
		}),
	],
} satisfies Record<ConnectStep, ReadonlyArray<IntegrationsMessage>>

const SceneModel = Schema.Struct({ id: Schema.String, title: Schema.String, hub: IntegrationsModel })

export const Model = Schema.Struct({ timeZone: Schema.String, scenes: Schema.Array(SceneModel) })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotHubMessage: { index: Schema.Number, message: IntegrationsMessage },
	ClickedConnectStep: { step: ConnectStep },
})
export type Message = typeof Message.Type

export type Return = Update.Return<Model, Message, Resources>

export const init = (flags: GcpLabFlags): Return => ({
	model: {
		timeZone: flags.timeZone,
		scenes: scenesAt(flags.nowMs).map((scene) => ({
			id: scene.id,
			title: scene.title,
			hub: hubOf(flags.nowMs, scene),
		})),
	},
})

const CONNECT_INDEX = 1

const applied = (model: Model, index: number, step: HubStep): Return => ({
	model: {
		...model,
		scenes: model.scenes.map((scene, at) => (at === index ? { ...scene, hub: step.hub } : scene)),
	},
	commands: Command.mapMessages(step.commands, (message) => Message.GotHubMessage({ index, message })),
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotHubMessage: ({ index, message: inner }) => {
			const scene = model.scenes[index]
			return scene === undefined ? { model } : applied(model, index, hubStep(scene.hub, inner))
		},
		ClickedConnectStep: ({ step }) => {
			const scene = model.scenes[CONNECT_INDEX]
			return scene === undefined
				? { model }
				: applied(model, CONNECT_INDEX, hubSteps(scene.hub, STEP_MESSAGES[step]))
		},
	})

const sceneView = Submodel.defineView<
	IntegrationsModel,
	IntegrationsMessage,
	Readonly<{ timeZone: string; isConnectSteps: boolean }>
>((hub, inputs, h) =>
	h.div(
		[h.Class("flex flex-col gap-4")],
		inputs.isConnectSteps ? vercelConfigure(h, hub) : vercelCard(h, hub, inputs.timeZone),
	),
)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	dashboardPage(h, {}, [
		h.div(
			[h.Class("mx-auto flex w-full max-w-6xl flex-col gap-8 p-4 font-display")],
			model.scenes.map((scene, index) =>
				h.section(
					[h.Key(scene.id), h.Id(`vercel-lab-${scene.id}`), h.Class("flex flex-col gap-2")],
					[
						h.h2([h.Class("text-xs text-muted-foreground")], [scene.title]),
						...(index === CONNECT_INDEX
							? [
									h.div(
										[h.Class("flex flex-wrap gap-2")],
										STEP_BUTTONS.map(({ step, label }) =>
											button(
												h,
												{
													size: "sm",
													variant: "outline",
													attributes: [h.OnClick(Message.ClickedConnectStep({ step }))],
												},
												[label],
											),
										),
									),
								]
							: []),
						h.submodel({
							slotId: `vercel-lab-${scene.id}`,
							model: scene.hub,
							view: sceneView,
							viewInputs: { timeZone: model.timeZone, isConnectSteps: index === CONNECT_INDEX },
							toParentMessage: (message) => Message.GotHubMessage({ index, message }),
						}),
					],
				),
			),
		),
	])
