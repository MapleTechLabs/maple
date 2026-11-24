import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { AlertRuleId } from "@maple/primitives"
import { Effect, Option, Schema, Array as Arr } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as IncidentMessage from "../page/alerts/incident/message"
import * as IncidentModel from "../page/alerts/incident/model"
import * as IncidentUpdate from "../page/alerts/incident/update"
import { breadcrumbsOf as incidentBreadcrumbs, view as incidentView } from "../page/alerts/incident/view"
import * as RuleMessage from "../page/alerts/rule/message"
import * as RuleModel from "../page/alerts/rule/model"
import * as RuleUpdate from "../page/alerts/rule/update"
import { breadcrumbsOf as ruleBreadcrumbs, view as ruleView } from "../page/alerts/rule/view"
import {
	destinationRow,
	incidentRow,
	INCIDENT_ID,
	NOW,
	ORG,
	ruleId,
	ruleRow,
	stateRow,
} from "../page/kit/alert-test-rows"
import type { PageContext } from "../page/contract"
import type { Resources } from "../platform/resources"

// `/lab/incident-actions`: the incident page and a rule's History tab over fixtures. `?state=` picks one:
// `incident` (open), `incident-acknowledged`, `incident-resolve` (the question before a resolve by
// hand), `incident-resolved`, `incident-locked` (a role that may not respond), `rule-history`.

export const LabState = Schema.Literals([
	"incident",
	"incident-acknowledged",
	"incident-resolve",
	"incident-resolved",
	"incident-locked",
	"rule-history",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "incident",
	),
}))

export const Model = Schema.Struct({
	state: LabState,
	incident: IncidentModel.Model,
	rule: RuleModel.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotIncidentMessage: { message: IncidentMessage.Message },
	GotRuleMessage: { message: RuleMessage.Message },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)(ORG),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const iso = (msBefore: number) => new Date(NOW - msBefore).toISOString()
const RULE = ruleRow(2, { name: "Checkout p95 latency", service_names_json: ["checkout"] })
const RULE_ID = Schema.decodeSync(AlertRuleId)(ruleId(2))

/** The pages' reads and writes are dropped: the fixture is all the data there is. */
const keepLocal = <M>(commands: ReadonlyArray<Command.Command<M, never, Resources>> | undefined) =>
	Arr.filter(
		commands ?? [],
		(command) => !/^(Fetch|Set|Resolve|Track|Create|Toggle|Delete|Save|Read)/.test(command.name),
	)

const fold = <PM, PS>(
	model: PM,
	messages: ReadonlyArray<PS>,
	step: (model: PM, message: PS) => { readonly model: PM },
): PM => Arr.reduce(messages, model, (current, message) => step(current, message).model)

const OPEN = incidentRow({ rule_name: RULE.name })
/** Dana acknowledged it four minutes after it opened. */
const ACKNOWLEDGED = incidentRow({
	rule_name: RULE.name,
	acknowledged_at: iso(106 * MINUTE),
	acknowledged_by_name: "Dana Kim",
	acknowledged_via: "web",
	first_acknowledged_at: iso(106 * MINUTE),
})
const RESOLVED = incidentRow({
	rule_name: RULE.name,
	status: "resolved",
	resolved_at: iso(20 * MINUTE),
	last_delivered_event_type: "resolve",
	first_acknowledged_at: iso(106 * MINUTE),
})

/** A rule's past incidents: acknowledged fast, acknowledged late, and never acknowledged. */
const HISTORY = [
	ACKNOWLEDGED,
	incidentRow({
		id: "0199a003-0000-7000-8000-000000000002",
		rule_name: RULE.name,
		status: "resolved",
		first_triggered_at: iso(26 * HOUR),
		resolved_at: iso(25 * HOUR),
		first_acknowledged_at: iso(26 * HOUR - 40 * 1000),
		last_observed_value: 1210,
	}),
	incidentRow({
		id: "0199a003-0000-7000-8000-000000000003",
		rule_name: RULE.name,
		status: "resolved",
		first_triggered_at: iso(3 * 24 * HOUR),
		resolved_at: iso(3 * 24 * HOUR - 2 * HOUR),
		first_acknowledged_at: iso(3 * 24 * HOUR - 65 * MINUTE),
		last_observed_value: 2390,
	}),
	incidentRow({
		id: "0199a003-0000-7000-8000-000000000004",
		rule_name: RULE.name,
		status: "resolved",
		first_triggered_at: iso(5 * 24 * HOUR),
		resolved_at: iso(5 * 24 * HOUR - 12 * MINUTE),
		last_observed_value: 905,
	}),
]

const incidentFor = (state: LabState) => {
	const stepOf = (model: IncidentModel.Model, message: IncidentMessage.Message) =>
		IncidentUpdate.update(model, message, CONTEXT)
	const row =
		state === "incident-acknowledged" ? ACKNOWLEDGED : state === "incident-resolved" ? RESOLVED : OPEN
	const loaded = fold(
		IncidentUpdate.init({ _tag: "AlertIncident", incidentId: INCIDENT_ID, search: {} }, CONTEXT).model,
		[
			IncidentMessage.Message.ReadClock({ nowMs: NOW }),
			IncidentMessage.Message.UpdatedIncidents({ orgId: ORG, rows: [row] }),
			IncidentMessage.Message.UpdatedRules({ orgId: ORG, rows: [RULE] }),
			IncidentMessage.Message.CompletedFetchSession({
				grants: Policy.grantsOf([state === "incident-locked" ? "org:analyst" : "org:engineer"]),
			}),
		],
		stepOf,
	)
	// The question is opened as a click opens it, so the dialog's own commands run.
	return state === "incident-resolve"
		? stepOf(loaded, IncidentMessage.Message.ClickedResolve())
		: { model: loaded, commands: [] }
}

const ruleFor = () =>
	fold(
		RuleUpdate.init({ _tag: "AlertRule", ruleId: RULE_ID, search: { tab: "history" } }, CONTEXT).model,
		[
			RuleMessage.Message.CompletedResolveWindow({
				window: { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" },
				nowMs: NOW,
				mode: "Load",
			}),
			RuleMessage.Message.ReadDiagnosisClock({ nowMs: NOW }),
			RuleMessage.Message.UpdatedRules({ orgId: ORG, rows: [RULE] }),
			RuleMessage.Message.UpdatedRuleStates({ orgId: ORG, rows: [stateRow(2)] }),
			RuleMessage.Message.UpdatedIncidents({ orgId: ORG, rows: HISTORY }),
			RuleMessage.Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
		],
		(model, message) => RuleUpdate.update(model, message, CONTEXT),
	)

export const init = (flags: Flags): Return => {
	const incident = incidentFor(flags.state)
	return {
		model: { state: flags.state, incident: incident.model, rule: ruleFor() },
		// The incident page's chart runtime still loads, so its chart draws.
		commands: Command.mapMessages(
			[
				...Arr.filter(
					IncidentUpdate.init(
						{ _tag: "AlertIncident", incidentId: INCIDENT_ID, search: {} },
						CONTEXT,
					).commands ?? [],
					(command) => command.name === "LoadChartRuntime",
				),
				...keepLocal(incident.commands),
			],
			(message) => Message.GotIncidentMessage({ message }),
		),
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotIncidentMessage: ({ message: child }) => {
			const next = IncidentUpdate.update(model.incident, child, CONTEXT)
			return {
				model: { ...model, incident: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotIncidentMessage({ message: inner }),
				),
			}
		},
		GotRuleMessage: ({ message: child }) => {
			const next = RuleUpdate.update(model.rule, child, CONTEXT)
			return {
				model: { ...model, rule: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotRuleMessage({ message: inner }),
				),
			}
		},
	})

export const breadcrumbs = (model: Model) =>
	model.state === "rule-history" ? ruleBreadcrumbs(model.rule) : incidentBreadcrumbs(model.incident)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	model.state === "rule-history"
		? h.submodel({
				slotId: "lab-incident-actions-rule",
				model: model.rule,
				view: ruleView,
				viewInputs: { context: CONTEXT },
				toParentMessage: (message: RuleMessage.Message) => Message.GotRuleMessage({ message }),
			})
		: h.submodel({
				slotId: "lab-incident-actions-incident",
				model: model.incident,
				view: incidentView,
				viewInputs: { context: CONTEXT },
				toParentMessage: (message: IncidentMessage.Message) =>
					Message.GotIncidentMessage({ message }),
			})
