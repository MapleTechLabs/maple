import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { Effect, Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"
import * as ChainDialog from "../page/alerts/escalation-dialog/dialog"
import * as EditorMessage from "../page/alerts/editor/message"
import * as EditorModel from "../page/alerts/editor/model"
import { init as editorInit } from "../page/alerts/editor/init"
import { update as editorUpdate } from "../page/alerts/editor/update"
import { breadcrumbsOf as editorBreadcrumbs, view as editorView } from "../page/alerts/editor/view"
import { chainSelectIdOf } from "../page/alerts/editor/form-steps"
import * as HubMessage from "../page/alerts/hub/message"
import * as HubModel from "../page/alerts/hub/model"
import * as HubUpdate from "../page/alerts/hub/update"
import { breadcrumbs as hubBreadcrumbs, view as hubView } from "../page/alerts/hub/view"
import * as IncidentMessage from "../page/alerts/incident/message"
import * as IncidentModel from "../page/alerts/incident/model"
import * as IncidentUpdate from "../page/alerts/incident/update"
import { breadcrumbsOf as incidentBreadcrumbs, view as incidentView } from "../page/alerts/incident/view"
import {
	chainDestinations,
	chainUuid,
	populatedChains,
	runOf,
} from "../page/alerts/shared/escalation-test-fixtures"
import { incidentRow, INCIDENT_ID, NOW, ORG, ruleId, ruleRow } from "../page/alerts/shared/test-rows"
import type { PageContext } from "../page/contract"
import type { Resources } from "../platform/resources"
import { keepLocal } from "./local-commands"

// `/lab/escalation`: escalation chains in the Routing tab, their dialog, a rule tier's chain picker
// and the incident rail, over fixtures. `?state=` picks one.

export const LabState = Schema.Literals([
	"chains-empty",
	"chains",
	"dialog-new",
	"dialog-edit",
	"dialog-invalid",
	"dialog-error",
	"rule-picker",
	"incident-escalating",
	"incident-paused",
	"incident-finished",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "chains",
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
type Step<PM, PS> = Readonly<{ model: PM; commands?: ReadonlyArray<Command.Command<PS, never, Resources>> }>

const CONTEXT: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const GRANTS = Policy.grantsOf(["org:engineer"])
const RULES = [
	ruleRow(1, { name: "Checkout error rate" }),
	ruleRow(2, { name: "Checkout p95 latency" }),
	ruleRow(3, { name: "Payments webhook failures" }),
]

/** Runs messages through a page's update, keeping the local commands (a dialog's open animation). */
const fold = <PM, PS>(
	start: Step<PM, PS>,
	messages: ReadonlyArray<PS>,
	step: (model: PM, message: PS) => Step<PM, PS>,
): Step<PM, PS> =>
	Arr.reduce(messages, { model: start.model, commands: keepLocal(start.commands) }, (current, message) => {
		const next = step(current.model, message)
		return { model: next.model, commands: [...(current.commands ?? []), ...keepLocal(next.commands)] }
	})

const hubStep = (model: HubModel.Model, message: HubMessage.Message) =>
	HubUpdate.update(model, message, CONTEXT)
const dialog = (message: ChainDialog.Message) => HubMessage.Message.GotChainDialogMessage({ message })

const SAVE_FAILURE: LoadFailure = {
	_tag: "@maple/http/errors/AlertValidationError",
	type: "invalid_request_error",
	code: "invalid_request",
	title: "Invalid request",
	message: "Step 2 names a destination that no longer exists.",
	retryable: false,
	recovery: "fix_request",
}

const hubFor = (state: LabState): Step<HubModel.Model, HubMessage.Message> => {
	const entered = HubUpdate.init({ _tag: "Alerts", search: { tab: "routing" } }, CONTEXT).model
	const chains = state === "chains-empty" ? [] : populatedChains([ruleId(1), ruleId(2), ruleId(3)])
	const base = [
		HubMessage.Message.ReadClock({ nowMs: NOW }),
		HubMessage.Message.CompletedFetchSession({ orgId: ORG, grants: GRANTS }),
		HubMessage.Message.UpdatedDestinations({ orgId: ORG, rows: chainDestinations }),
		HubMessage.Message.UpdatedRules({ orgId: ORG, rows: RULES }),
		HubMessage.Message.CompletedFetchRoutingDeliveries({
			key: entered.routingDeliveries.key ?? "",
			result: Result.succeed([]),
		}),
		HubMessage.Message.CompletedFetchChains({
			key: entered.chains.key ?? "",
			result: Result.succeed(chains),
		}),
	]
	const firstStepKey = "s0"
	const extra: ReadonlyArray<HubMessage.Message> =
		state === "dialog-new"
			? [HubMessage.Message.ClickedNewChain()]
			: state === "dialog-invalid"
				? [
						HubMessage.Message.ClickedNewChain(),
						dialog(ChainDialog.Message.ChangedWait({ key: firstStepKey, value: "2000" })),
						dialog(ChainDialog.Message.ClickedSave()),
					]
				: state === "dialog-error"
					? [
							HubMessage.Message.GotRowMenuMessage({
								menuId: `chain:${chainUuid(1)}`,
								message: Menu.Message.ClickedItem({
									index: 0,
									item: { kind: "Item", value: "edit" },
								}),
							}),
							dialog(ChainDialog.Message.ClickedSave()),
							dialog(
								ChainDialog.Message.CompletedSave({
									openCount: 1,
									result: Result.fail(SAVE_FAILURE),
								}),
							),
						]
					: state === "dialog-edit"
						? [
								HubMessage.Message.GotRowMenuMessage({
									menuId: `chain:${chainUuid(3)}`,
									message: Menu.Message.ClickedItem({
										index: 0,
										item: { kind: "Item", value: "edit" },
									}),
								}),
							]
						: []
	return fold({ model: entered }, [...base, ...extra], hubStep)
}

const editorStep = (model: EditorModel.Model, message: EditorMessage.Message) =>
	editorUpdate(model, message, CONTEXT)

const editorFor = (): Step<EditorModel.Model, EditorMessage.Message> => {
	const start = editorInit({ _tag: "AlertsCreate", search: { template: "high_error_rate" } }, CONTEXT)
	const pick = (tier: "warning" | "critical", value: string) =>
		EditorMessage.Message.GotSelectMessage({
			id: chainSelectIdOf(tier),
			message: Select.Message.SelectedItem({ index: 1, value }),
		})
	return fold(
		start,
		[
			EditorMessage.Message.GeneratedDraftId({ id: "6f1c2e3a-0000-4000-8000-000000000001" }),
			EditorMessage.Message.CompletedReadClock({ nowMs: NOW }),
			EditorMessage.Message.CompletedReadGrants({ grants: GRANTS }),
			EditorMessage.Message.UpdatedDestinations({ orgId: ORG, rows: chainDestinations }),
			EditorMessage.Message.UpdatedRules({ orgId: ORG, rows: RULES }),
			EditorMessage.Message.CompletedFetchConnectors({ connectors: [] }),
			EditorMessage.Message.CompletedFetchEscalationChains({
				chains: populatedChains([ruleId(1), ruleId(2), ruleId(3)]),
			}),
			EditorMessage.Message.ChangedField({ field: "name", value: "Checkout error rate" }),
			EditorMessage.Message.ClickedAddCriticalTier(),
			pick("warning", chainUuid(1)),
		],
		editorStep,
	)
}

const incidentStep = (model: IncidentModel.Model, message: IncidentMessage.Message) =>
	IncidentUpdate.update(model, message, CONTEXT)

const incidentFor = (state: LabState): Step<IncidentModel.Model, IncidentMessage.Message> => {
	const start = IncidentUpdate.init({ _tag: "AlertIncident", incidentId: INCIDENT_ID, search: {} }, CONTEXT)
	const isPaused = state === "incident-paused"
	const row = incidentRow({
		rule_name: "Checkout p95 latency",
		acknowledged_at: isPaused ? new Date(NOW - 4 * 60_000).toISOString() : null,
		acknowledged_by_name: isPaused ? "Dana Kim" : null,
	})
	const synced = fold(
		start,
		[
			IncidentMessage.Message.ReadClock({ nowMs: NOW }),
			IncidentMessage.Message.UpdatedIncidents({ orgId: ORG, rows: [row] }),
			IncidentMessage.Message.UpdatedRules({
				orgId: ORG,
				rows: [ruleRow(2, { name: "Checkout p95 latency" })],
			}),
			IncidentMessage.Message.UpdatedRuleStates({ orgId: ORG, rows: [] }),
		],
		incidentStep,
	)
	const run =
		state === "incident-finished"
			? runOf("exhausted", { step: 3, stepsSent: 9 })
			: isPaused
				? runOf("acknowledged")
				: runOf("active")
	const settled = fold(
		synced,
		[
			IncidentMessage.Message.CompletedFetchEscalation({
				key: synced.model.escalation.key ?? "",
				result: Result.succeed(run),
			}),
			IncidentMessage.Message.CompletedFetchDeliveries({
				key: synced.model.deliveries.key ?? "",
				result: Result.succeed([]),
			}),
			IncidentMessage.Message.CompletedFetchInvestigation({
				key: synced.model.investigation.key ?? "",
				result: Result.succeed(null),
			}),
		],
		incidentStep,
	)
	return settled
}

const isHub = (state: LabState) =>
	state === "chains" || state === "chains-empty" || Str.startsWith("dialog-")(state)
const isIncident = (state: LabState) => Str.startsWith("incident-")(state)

export const init = (flags: Flags): Return => {
	const hub = hubFor(flags.state)
	const editor = editorFor()
	const incident = incidentFor(flags.state)
	return {
		model: { state: flags.state, hub: hub.model, editor: editor.model, incident: incident.model },
		commands: [
			...(isHub(flags.state)
				? Command.mapMessages(hub.commands ?? [], (message) => Message.GotHubMessage({ message }))
				: []),
			...(flags.state === "rule-picker"
				? Command.mapMessages(editor.commands ?? [], (message) =>
						Message.GotEditorMessage({ message }),
					)
				: []),
			...(isIncident(flags.state)
				? Command.mapMessages(incident.commands ?? [], (message) =>
						Message.GotIncidentMessage({ message }),
					)
				: []),
		],
	}
}

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
			const next = editorUpdate(model.editor, child, CONTEXT)
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
	isHub(model.state)
		? hubBreadcrumbs(model.hub)
		: isIncident(model.state)
			? incidentBreadcrumbs(model.incident)
			: editorBreadcrumbs(model.editor)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	isHub(model.state)
		? h.submodel({
				slotId: "lab-escalation-hub",
				model: model.hub,
				view: hubView,
				viewInputs: { context: CONTEXT },
				toParentMessage: (message: HubMessage.Message) => Message.GotHubMessage({ message }),
			})
		: isIncident(model.state)
			? h.submodel({
					slotId: "lab-escalation-incident",
					model: model.incident,
					view: incidentView,
					viewInputs: { context: CONTEXT },
					toParentMessage: (message: IncidentMessage.Message) =>
						Message.GotIncidentMessage({ message }),
				})
			: h.submodel({
					slotId: "lab-escalation-editor",
					model: model.editor,
					view: editorView,
					viewInputs: { context: CONTEXT },
					toParentMessage: (message: EditorMessage.Message) =>
						Message.GotEditorMessage({ message }),
				})
