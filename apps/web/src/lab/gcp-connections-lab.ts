import { V2GcpConnector } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Message as IntegrationsMessage } from "../page/integrations/message"
import { Model as IntegrationsModel } from "../page/integrations/model"
import { gcpConnection } from "../page/integrations/view-gcp-connection"
import { gcpDialogs } from "../page/integrations/view-gcp-dialogs"
import { dashboardPage } from "../page/kit/dashboard-page"
import type { Resources } from "../platform/resources"
import { agoOf, connectorOf, type GcpLabFlags, hubOf, hubStep, withIndexId } from "./gcp-host"

// `/lab/gcp-connections`: each state of a Google Cloud
// connection over fixture data, as an admin sees it.

/** A project connection whose script ran an hour ago and that delivers both. */
const baseConnector = (ago: (minutes: number) => string) => ({
	id: "gcpc_YofPTrK9782DWwcnXhpcCw",
	object: "gcp_connector",
	scope_type: "project",
	scope_id: "maple-development-project",
	project_id: "maple-development-project",
	logs_enabled: true,
	metrics_enabled: true,
	created_at: ago(90),
	last_log_received_at: ago(1),
	last_log_error: null,
	applied_logs_enabled: true,
	applied_metrics_enabled: true,
	setup_reported_at: ago(60),
	last_metrics_received_at: ago(4),
	last_metrics_error: null,
	discovered_project_count: 1,
	last_resources_error: null,
})

export const scenariosAt = (nowMs: number): ReadonlyArray<{ title: string; connector: V2GcpConnector }> => {
	const ago = agoOf(nowMs)
	const base = baseConnector(ago)
	const scenarios: ReadonlyArray<{ title: string; over: Readonly<Record<string, unknown>> }> = [
		{ title: "Healthy project", over: {} },
		{
			title: "Healthy folder",
			over: {
				scope_type: "folder",
				scope_id: "482910374615",
				project_id: "maple-shared-logging",
				discovered_project_count: 13,
				last_log_received_at: ago(0.2),
				last_metrics_received_at: ago(2),
			},
		},
		{
			title: "Waiting for the first data",
			over: { setup_reported_at: ago(3), last_log_received_at: null, last_metrics_received_at: null },
		},
		{
			title: "Overdue",
			over: { setup_reported_at: ago(24), last_log_received_at: null, last_metrics_received_at: null },
		},
		{
			title: "Log forwarding failing",
			over: {
				last_log_received_at: ago(120),
				last_log_error:
					"The log sink can't publish to Maple's topic. Run the setup script again: it restores the permission. Google answered: PERMISSION_DENIED: pubsub.topics.publish.",
				last_metrics_received_at: ago(2),
			},
		},
		{
			title: "Setup pending",
			over: {
				applied_logs_enabled: null,
				applied_metrics_enabled: null,
				setup_reported_at: null,
				last_log_received_at: null,
				last_metrics_received_at: null,
			},
		},
	]
	return scenarios.map(({ title, over }, index) => ({
		title,
		connector: withIndexId(connectorOf(base, over), index),
	}))
}

export const Model = Schema.Struct({
	timeZone: Schema.String,
	titles: Schema.Array(Schema.String),
	/** The cards' connectors, fixed whatever the page's status read becomes. */
	connectors: Schema.Array(V2GcpConnector),
	hub: IntegrationsModel,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotHubMessage: { message: IntegrationsMessage } })
export type Message = typeof Message.Type

export type Return = Update.Return<Model, Message, Resources>

export const init = (flags: GcpLabFlags): Return => {
	const scenarios = scenariosAt(flags.nowMs)
	const connectors = scenarios.map((scenario) => scenario.connector)
	return {
		model: {
			timeZone: flags.timeZone,
			titles: scenarios.map((scenario) => scenario.title),
			connectors,
			hub: hubOf(flags.nowMs, connectors),
		},
	}
}

/** Configure and the run-script buttons open nothing in the lab. */
export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotHubMessage: ({ message: inner }) => {
			const next = hubStep(model.hub, inner)
			if (model.hub.gcpCard.configure === null && next.hub.gcpCard.configure !== null)
				return {
					model: {
						...model,
						hub: { ...next.hub, gcpCard: { ...next.hub.gcpCard, configure: null } },
					},
				}
			return {
				model: { ...model, hub: next.hub },
				commands: Command.mapMessages(next.commands, (child) =>
					Message.GotHubMessage({ message: child }),
				),
			}
		},
	})

const connectionsView = Submodel.defineView<
	IntegrationsModel,
	IntegrationsMessage,
	Readonly<{ timeZone: string; titles: ReadonlyArray<string>; connectors: ReadonlyArray<V2GcpConnector> }>
>((hub, inputs, h) =>
	dashboardPage(h, {}, [
		h.div(
			[h.Class("mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 font-display")],
			inputs.connectors.map((connector, index) =>
				h.section(
					[h.Key(connector.id), h.Class("flex flex-col gap-2")],
					[
						h.h2([h.Class("text-xs text-muted-foreground")], [inputs.titles[index] ?? ""]),
						gcpConnection(h, hub, connector, inputs.timeZone),
					],
				),
			),
		),
		...gcpDialogs(h, hub, inputs.timeZone),
	]),
)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "gcp-connections-lab",
		model: model.hub,
		view: connectionsView,
		viewInputs: { timeZone: model.timeZone, titles: model.titles, connectors: model.connectors },
		toParentMessage: (message) => Message.GotHubMessage({ message }),
	})
