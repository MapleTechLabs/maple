import {
	GithubIntegrationStatus,
	LinearIntegrationStatus,
	SupabaseIntegrationStatus,
} from "@maple/domain/http"
import { V2ChatConnectorList } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { AsyncData, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Message as IntegrationsMessage } from "../page/integrations/message"
import { Model as IntegrationsModel } from "../page/integrations/model"
import * as Integrations from "../page/integrations/update"
import { githubCard } from "../page/integrations/view-github"
import { chatCard } from "../page/integrations/view-chat-card"
import { linearCard } from "../page/integrations/view-linear"
import { supabaseCard } from "../page/infra-integrations/supabase/integration/view-supabase"
import { dashboardPage } from "../page/kit/dashboard-page"
import type { Resources } from "../platform/resources"
import { type GcpLabFlags, LAB_CONTEXT } from "./gcp-host"

// `/lab/integration-features`: the Supabase, GitHub, Linear and Slack cards with their switches, over
// fixture statuses. Flips update the page's model; no request is sent.

const project = (ref: string, name: string, over: Readonly<Record<string, unknown>>) => ({
	ref,
	name,
	region: "eu-central-1",
	status: "ACTIVE_HEALTHY",
	metricsEnabled: false,
	logDrainEnabled: false,
	logDrainError: null,
	logDrainSourceId: null,
	logDrains: [],
	logDrainsCheckedAt: null,
	logsEnabled: false,
	logsLastPolledAt: null,
	logsError: null,
	lastSeenAt: 1_760_000_000_000,
	...over,
})

const supabaseStatus = (nowMs: number) =>
	Schema.decodeSync(SupabaseIntegrationStatus)({
		configured: true,
		connected: true,
		organization: { id: "org-1", slug: "acme", name: "Acme" },
		connectedByUserId: null,
		connectedAt: nowMs - 86_400_000,
		revoked: false,
		lastDiscoveryAt: nowMs - 300_000,
		lastDiscoveryError: null,
		projects: [
			project("storefrontabcdefghij", "storefront", {
				metricsEnabled: true,
				logsEnabled: true,
				logsLastPolledAt: nowMs - 41_000,
			}),
			project("apiprojectabcdefghij", "api", {
				metricsEnabled: true,
				logDrainEnabled: true,
				region: "us-east-1",
			}),
			project("workerprojectabcdefg", "worker", {}),
			project("sandboxprojectabcdef", "sandbox", { status: "INACTIVE" }),
		],
	})

const repo = (index: number, name: string, prReviewEnabled: boolean) => ({
	id: `0199a005-0000-7000-8000-00000000000${index}`,
	fullName: `acme-shop/${name}`,
	htmlUrl: `https://github.com/acme-shop/${name}`,
	isPrivate: true,
	status: "active" as const,
	syncStatus: "ready" as const,
	lastSyncedAt: 1,
	lastSyncError: null,
	trackedBranch: "main",
	branches: [{ name: "main", isDefault: true }],
	prReviewEnabled,
})

const githubStatus = Schema.decodeSync(GithubIntegrationStatus)({
	connected: true,
	state: "connected",
	accountLogin: "acme-shop",
	accountType: "organization",
	repositorySelection: "selected",
	ciTracesEnabled: true,
	auditLogEnabled: true,
	repositoryDiscovery: null,
	repositories: [repo(1, "shop", true), repo(2, "api", false), repo(3, "docs", false)],
})

const linearStatus = Schema.decodeSync(LinearIntegrationStatus)({
	connected: true,
	workspaceName: "Acme",
	connectedByUserId: null,
	revoked: false,
	features: {
		openIssuesEnabled: true,
		updateCommentsEnabled: true,
		reopenIssuesEnabled: false,
		resolveCommentsEnabled: true,
	},
})

const chatStatus = (nowMs: number) =>
	Schema.decodeSync(V2ChatConnectorList)({
		object: "chat_connector_list",
		data: [
			{
				id: "slack",
				object: "chat_connector",
				name: "Slack",
				available: true,
				supports_identity: false,
				workspaces: [
					{
						id: "chatw_YoxMqYdzUJ1tH4BqCWxPH3",
						object: "chat_workspace",
						connector: "slack",
						external_workspace_id: "T1",
						name: "Acme Shop",
						settings: {},
						alerts_enabled: true,
						direct_messages_enabled: true,
						assistant_enabled: false,
						created_at: new Date(nowMs - 3 * 86_400_000).toISOString(),
					},
				],
			},
		],
	})

export const Model = Schema.Struct({ timeZone: Schema.String, hub: IntegrationsModel })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotHubMessage: { message: IntegrationsMessage } })
export type Message = typeof Message.Type

export type Return = Update.Return<Model, Message, Resources>

export const init = (flags: GcpLabFlags): Return => {
	const hub = Integrations.init({ search: {} }, LAB_CONTEXT).model
	return {
		model: {
			timeZone: flags.timeZone,
			hub: {
				...hub,
				nowMs: flags.nowMs,
				statuses: {
					...hub.statuses,
					supabase: { key: null, data: AsyncData.Success({ data: supabaseStatus(flags.nowMs) }) },
					github: { key: null, data: AsyncData.Success({ data: githubStatus }) },
					linear: { key: null, data: AsyncData.Success({ data: linearStatus }) },
					chat: { key: null, data: AsyncData.Success({ data: chatStatus(flags.nowMs) }) },
				},
			},
		},
	}
}

/** The page's own update over the fixtures; its requests are dropped, so a flip stays saving. */
export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotHubMessage: ({ message: inner }) => ({
			model: { ...model, hub: Integrations.update(model.hub, inner, LAB_CONTEXT).model },
		}),
	})

const supabaseView = Submodel.defineView<
	IntegrationsModel,
	IntegrationsMessage,
	Readonly<{ timeZone: string }>
>((hub, inputs, h) => supabaseCard(h, hub, inputs.timeZone))

const githubView = Submodel.defineView<
	IntegrationsModel,
	IntegrationsMessage,
	Readonly<{ timeZone: string }>
>((hub, inputs, h) => h.div([], githubCard(h, hub, inputs.timeZone)))

const linearView = Submodel.defineView<IntegrationsModel, IntegrationsMessage, Readonly<{}>>(
	(hub, _inputs, h) => linearCard(h, hub),
)

/** The card reads the page's integration, so the slot shows it the Slack page. */
const chatView = Submodel.defineView<IntegrationsModel, IntegrationsMessage, Readonly<{ timeZone: string }>>(
	(hub, inputs, h) =>
		chatCard(h, { ...hub, search: { ...hub.search, integration: "chat-slack" } }, inputs.timeZone),
)

/** Each card in its own slot: both render the page's disconnect dialog. */
export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	dashboardPage(h, {}, [
		h.div(
			[h.Class("mx-auto flex w-full max-w-5xl flex-col gap-10 p-4 font-display")],
			[
				h.section(
					[h.Id("supabase")],
					[
						h.submodel({
							slotId: "integration-features-supabase",
							model: model.hub,
							view: supabaseView,
							viewInputs: { timeZone: model.timeZone },
							toParentMessage: (message) => Message.GotHubMessage({ message }),
						}),
					],
				),
				h.section(
					[h.Id("github")],
					[
						h.submodel({
							slotId: "integration-features-github",
							model: model.hub,
							view: githubView,
							viewInputs: { timeZone: model.timeZone },
							toParentMessage: (message) => Message.GotHubMessage({ message }),
						}),
					],
				),
				h.section(
					[h.Id("linear")],
					[
						h.submodel({
							slotId: "integration-features-linear",
							model: model.hub,
							view: linearView,
							viewInputs: {},
							toParentMessage: (message) => Message.GotHubMessage({ message }),
						}),
					],
				),
				h.section(
					[h.Id("chat")],
					[
						h.submodel({
							slotId: "integration-features-chat",
							model: model.hub,
							view: chatView,
							viewInputs: { timeZone: model.timeZone },
							toParentMessage: (message) => Message.GotHubMessage({ message }),
						}),
					],
				),
			],
		),
	])
