import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { Effect, Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { AlertDestinationId } from "@maple/domain/http"
import * as Menu from "@maple/views/ui/menu"
import * as DestinationDialog from "../page/alerts/destination/dialog"
import { menuIdOf } from "../page/alerts/editor/dest-steps"
import * as EditorMessage from "../page/alerts/editor/message"
import * as EditorModel from "../page/alerts/editor/model"
import { init as initEditor } from "../page/alerts/editor/init"
import { update as updateEditor } from "../page/alerts/editor/update"
import { breadcrumbsOf as editorCrumbs, view as editorView } from "../page/alerts/editor/view"
import * as HubMessage from "../page/alerts/hub/message"
import * as HubModel from "../page/alerts/hub/model"
import * as HubUpdate from "../page/alerts/hub/update"
import { view as hubView } from "../page/alerts/hub/view"
import * as IncidentMessage from "../page/alerts/incident/message"
import * as IncidentModel from "../page/alerts/incident/model"
import * as IncidentUpdate from "../page/alerts/incident/update"
import { breadcrumbsOf as incidentCrumbs, view as incidentView } from "../page/alerts/incident/view"
import {
	anomalyAlertIncidentId,
	anomalyIncidentRow,
	anomalyTimeseriesWire,
	anomalyWire,
	defaultAnomalyRuleRow,
	scopedAnomalyRuleRow,
} from "../page/alerts/shared/anomaly-test-fixtures"
import {
	destinationRow,
	incidentRow,
	NOW,
	ORG,
	ruleId,
	ruleRow,
	stateRow,
} from "../page/alerts/shared/test-rows"
import type { PageContext } from "../page/contract"
import type { Resources } from "../platform/resources"

// `/lab/anomaly-alerts`: anomalies paging through alert rules, over fixtures. `?state=` picks one:
// editor-new, editor-scoped, editor-default, editor-critical-destination, incident-warning, incident-critical, incident-spike,
// hub-anomalies, hub-anomalies-resolved, hub-anomalies-empty, hub-rules.

export const LabState = Schema.Literals([
	"editor-new",
	"editor-scoped",
	"editor-default",
	"editor-critical-destination",
	"incident-warning",
	"incident-critical",
	"incident-spike",
	"hub-anomalies",
	"hub-anomalies-resolved",
	"hub-anomalies-empty",
	"hub-rules",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "hub-anomalies",
	),
}))

export const Model = Schema.Struct({
	state: LabState,
	hub: HubModel.Model,
	editor: EditorModel.Model,
	incident: IncidentModel.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotHubMessage: { message: HubMessage.Message },
	GotEditorMessage: { message: EditorMessage.Message },
	GotIncidentMessage: { message: IncidentMessage.Message },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const CONTEXT: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }

/** The pages' reads and writes are dropped: the fixture is all the data there is. */
const keepLocal = <M>(commands: ReadonlyArray<Command.Command<M, never, Resources>> | undefined) =>
	Arr.filter(
		commands ?? [],
		(command) => !/^(Fetch|Toggle|Delete|Save|Read|Generate|Run|Set|Create)/.test(command.name),
	)

const fold = <PM, PS>(
	model: PM,
	messages: ReadonlyArray<PS>,
	step: (model: PM, message: PS) => { readonly model: PM },
) => Arr.reduce(messages, model, (current, message) => step(current, message).model)

const RULES = [
	ruleRow(2, { name: "Payment p95 latency", tags_json: ["team:payments"] }),
	defaultAnomalyRuleRow(),
	scopedAnomalyRuleRow(),
]

const OPEN = [
	anomalyIncidentRow({
		n: 1,
		ruleN: 8,
		severity: "critical",
		service: "checkout",
		environment: "production",
	}),
	anomalyIncidentRow({ n: 2, ruleN: 7, severity: "warning", service: "search", environment: "production" }),
	anomalyIncidentRow(
		{ n: 5, ruleN: 7, severity: "critical", service: "payments-worker", environment: "production" },
		{ acknowledged_at: new Date(NOW - 20 * 60_000).toISOString(), acknowledged_by_name: "Ada Lovelace" },
	),
]
const RESOLVED = [
	anomalyIncidentRow({
		n: 3,
		ruleN: 8,
		severity: "warning",
		service: "checkout",
		environment: "staging",
		status: "resolved",
	}),
	anomalyIncidentRow({
		n: 6,
		ruleN: 7,
		severity: "critical",
		service: "search",
		environment: "production",
		status: "resolved",
	}),
]

const hubFor = (state: LabState) => {
	const search: HubModel.Model["search"] =
		state === "hub-rules"
			? { tab: "rules" }
			: state === "hub-anomalies-resolved"
				? { signal: "anomaly", anomalyStatus: "all" }
				: { signal: "anomaly" }
	const incidents =
		state === "hub-anomalies-empty"
			? [incidentRow({ rule_name: "Payment p95 latency" })]
			: [incidentRow({ rule_name: "Payment p95 latency" }), ...OPEN, ...RESOLVED]
	return fold(
		HubUpdate.init({ _tag: "Alerts", search }, CONTEXT).model,
		[
			HubMessage.Message.ReadClock({ nowMs: NOW }),
			HubMessage.Message.UpdatedRules({ orgId: ORG, rows: RULES }),
			HubMessage.Message.UpdatedRuleStates({
				orgId: ORG,
				rows: [
					stateRow(2, { last_status: "breached", last_value: 1840 }),
					stateRow(7, { last_value: 2 }),
					stateRow(8, { last_value: 0 }),
				],
			}),
			HubMessage.Message.UpdatedIncidents({ orgId: ORG, rows: incidents }),
			HubMessage.Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
			HubMessage.Message.CompletedFetchSession({ orgId: ORG, grants: Policy.allPermissions }),
		],
		(model, message) => HubUpdate.update(model, message, CONTEXT),
	)
}

const editorSearch = (state: LabState): EditorModel.Model["search"] =>
	state === "editor-scoped"
		? { ruleId: ruleId(8) }
		: state === "editor-default"
			? { ruleId: ruleId(7) }
			: { template: "anomaly" }

const editorFor = (state: LabState) =>
	fold(
		initEditor({ _tag: "AlertsCreate", search: editorSearch(state) }, CONTEXT).model,
		[
			EditorMessage.Message.GeneratedDraftId({ id: "6f1c2e3a-0000-4000-8000-000000000001" }),
			EditorMessage.Message.CompletedReadClock({ nowMs: NOW }),
			EditorMessage.Message.CompletedReadGrants({ grants: Policy.allPermissions }),
			EditorMessage.Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
			EditorMessage.Message.UpdatedRules({ orgId: ORG, rows: RULES }),
			...(state === "editor-critical-destination"
				? [
						EditorMessage.Message.ChangedField({ field: "name", value: "Search anomalies" }),
						EditorMessage.Message.ToggledAnomalySignal({ signal: "latency_p95" }),
						EditorMessage.Message.GotMenuMessage({
							id: menuIdOf("critical"),
							message: Menu.Message.ClickedItem({
								index: 0,
								item: { kind: "Item", value: "type:webhook" },
							}),
						}),
						EditorMessage.Message.GotDestinationDialogMessage({
							message: DestinationDialog.Message.CompletedSave({
								openCount: 1,
								isCreate: true,
								result: Result.succeed(PAGER_ID),
							}),
						}),
						EditorMessage.Message.UpdatedDestinations({
							orgId: ORG,
							rows: [
								destinationRow(),
								destinationRow({
									id: PAGER_ID,
									name: "Search pager",
									config_json: {
										summary: "https://pager.acme.test/search",
										channelLabel: null,
									},
								}),
							],
						}),
					]
				: []),
			...(state === "editor-new"
				? [
						EditorMessage.Message.ChangedField({ field: "name", value: "Search anomalies" }),
						EditorMessage.Message.ToggledAnomalySignal({ signal: "latency_p95" }),
						EditorMessage.Message.ToggledAnomalySignal({ signal: "throughput" }),
					]
				: []),
		],
		(model, message) => updateEditor(model, message, CONTEXT),
	)

const INCIDENTS = {
	"incident-warning": { n: 4, signal: "latency_p95", severity: "warning", service: "search" },
	"incident-critical": { n: 1, signal: "error_rate", severity: "critical", service: "checkout" },
	"incident-spike": { n: 3, signal: "error_spike", severity: "critical", service: "payments-worker" },
} as const

const incidentFor = (state: LabState) => {
	const scenario =
		state === "incident-warning" || state === "incident-critical" || state === "incident-spike"
			? INCIDENTS[state]
			: INCIDENTS["incident-critical"]
	const row = anomalyIncidentRow({
		n: scenario.n,
		ruleN: scenario.service === "checkout" ? 8 : 7,
		severity: scenario.severity,
		service: scenario.service,
		environment: "production",
	})
	const entered = IncidentUpdate.init(
		{ _tag: "AlertIncident", incidentId: anomalyAlertIncidentId(scenario.n), search: {} },
		CONTEXT,
	).model
	const synced = fold(
		entered,
		[
			IncidentMessage.Message.ReadClock({ nowMs: NOW }),
			IncidentMessage.Message.UpdatedIncidents({ orgId: ORG, rows: [row] }),
			IncidentMessage.Message.UpdatedRules({ orgId: ORG, rows: RULES }),
		],
		(model, message) => IncidentUpdate.update(model, message, CONTEXT),
	)
	return fold(
		synced,
		[
			IncidentMessage.Message.CompletedFetchAnomaly({
				key: synced.anomaly.key ?? "",
				result: Result.succeed(
					anomalyWire(scenario.n, scenario.signal, scenario.severity, scenario.service),
				),
			}),
			IncidentMessage.Message.CompletedFetchAnomalyTimeseries({
				key: synced.anomalyTimeseries.key ?? "",
				result: Result.succeed(anomalyTimeseriesWire(scenario.signal)),
			}),
			IncidentMessage.Message.CompletedFetchDeliveries({
				key: synced.deliveries.key ?? "",
				result: Result.succeed([]),
			}),
			IncidentMessage.Message.CompletedFetchActivity({
				key: synced.activity.key ?? "",
				result: Result.succeed([]),
			}),
			IncidentMessage.Message.CompletedFetchSession({ grants: Policy.allPermissions }),
			IncidentMessage.Message.CompletedFetchSilences({
				key: synced.silences.key ?? "",
				result: Result.succeed([]),
			}),
			IncidentMessage.Message.CompletedFetchInvestigation({
				key: synced.investigation.key ?? "",
				result: Result.succeed(null),
			}),
		],
		(model, message) => IncidentUpdate.update(model, message, CONTEXT),
	)
}

const PAGER_ID = Schema.decodeSync(AlertDestinationId)("0199a001-0000-7000-8000-000000000009")

const isEditor = Str.startsWith("editor")
const isIncident = Str.startsWith("incident")

export const init = (flags: Flags): Return => ({
	model: {
		state: flags.state,
		hub: hubFor(flags.state),
		editor: editorFor(flags.state),
		incident: incidentFor(flags.state),
	},
	// The incident page's chart runtime still loads, so its anomaly chart draws.
	commands: Command.mapMessages(
		keepLocal(
			IncidentUpdate.init(
				{ _tag: "AlertIncident", incidentId: anomalyAlertIncidentId(1), search: {} },
				CONTEXT,
			).commands,
		),
		(message) => Message.GotIncidentMessage({ message }),
	),
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotHubMessage: ({ message: child }) => {
			const next = HubUpdate.update(model.hub, child, CONTEXT)
			return {
				model: { ...model, hub: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotHubMessage({ message: inner }),
				),
			}
		},
		GotEditorMessage: ({ message: child }) => {
			const next = updateEditor(model.editor, child, CONTEXT)
			return {
				model: { ...model, editor: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotEditorMessage({ message: inner }),
				),
			}
		},
		GotIncidentMessage: ({ message: child }) => {
			const next = IncidentUpdate.update(model.incident, child, CONTEXT)
			return {
				model: { ...model, incident: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotIncidentMessage({ message: inner }),
				),
			}
		},
	})

export const breadcrumbs = (model: Model) =>
	isEditor(model.state)
		? editorCrumbs(model.editor)
		: isIncident(model.state)
			? incidentCrumbs(model.incident)
			: [{ label: "Alerts" }]

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	isEditor(model.state)
		? h.submodel({
				slotId: "lab-anomaly-editor",
				model: model.editor,
				view: editorView,
				viewInputs: { context: CONTEXT },
				toParentMessage: (message: EditorMessage.Message) => Message.GotEditorMessage({ message }),
			})
		: isIncident(model.state)
			? h.submodel({
					slotId: "lab-anomaly-incident",
					model: model.incident,
					view: incidentView,
					viewInputs: { context: CONTEXT },
					toParentMessage: (message: IncidentMessage.Message) =>
						Message.GotIncidentMessage({ message }),
				})
			: h.submodel({
					slotId: "lab-anomaly-hub",
					model: model.hub,
					view: hubView,
					viewInputs: { context: CONTEXT },
					toParentMessage: (message: HubMessage.Message) => Message.GotHubMessage({ message }),
				})
