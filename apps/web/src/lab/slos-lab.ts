import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { SloPublicId } from "@maple/domain/http/v2"
import { sloRuleName } from "@maple/domain/slo"
import { Effect, Option, Result, Schema, Array as Arr } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as HubMessage from "../page/alerts/hub/message"
import * as HubModel from "../page/alerts/hub/model"
import * as HubUpdate from "../page/alerts/hub/update"
import { breadcrumbs as hubBreadcrumbs, view as hubView } from "../page/alerts/hub/view"
import {
	budgetIncidentRow,
	burnIncidentRow,
	checkoutSlo,
	lowTargetSlo,
	searchSlo,
	sloHistory,
	sloStatus,
	sloUuid,
	type SloScenario,
} from "../page/alerts/shared/slo-test-fixtures"
import { destinationRow, hubAt, NOW, ORG } from "../page/kit/alert-test-rows"
import * as SloMessage from "../page/alerts/slo/message"
import * as SloModel from "../page/alerts/slo/model"
import * as SloUpdate from "../page/alerts/slo/update"
import { breadcrumbsOf, view as sloView } from "../page/alerts/slo/view"
import * as FormMessage from "../page/alerts/slo-form/message"
import * as FormModel from "../page/alerts/slo-form/model"
import * as FormUpdate from "../page/alerts/slo-form/update"
import { view as formView } from "../page/alerts/slo-form/view"
import type { PageContext } from "../page/contract"
import type { Resources } from "../platform/resources"

// `/lab/slos`: the SLOs tab, the SLO page and the SLO form over fixtures. `?state=` picks one:
// tab-empty, tab, loading, healthy, burning, slow (only the slow tier fires), low-target (a 90%
// target, capped factors), holding, sparse (too few events to judge), no-data, exhausted,
// budget-spent (its incident open), burning-spent (both incidents open), status-error,
// incidents-unavailable, form-new, form-low-target, form-invalid, form-edit.

export const LabState = Schema.Literals([
	"tab-empty",
	"tab",
	"loading",
	"healthy",
	"burning",
	"slow",
	"low-target",
	"holding",
	"sparse",
	"no-data",
	"exhausted",
	"budget-spent",
	"burning-spent",
	"status-error",
	"incidents-unavailable",
	"form-new",
	"form-low-target",
	"form-invalid",
	"form-edit",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "tab",
	),
}))

export const Model = Schema.Struct({
	state: LabState,
	hub: HubModel.Model,
	slo: SloModel.Model,
	form: FormModel.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotHubMessage: { message: HubMessage.Message },
	GotSloMessage: { message: SloMessage.Message },
	GotFormMessage: { message: FormMessage.Message },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)(ORG),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const GRANTS = Policy.grantsOf(["org:engineer"])
const publicId = Schema.encodeSync(SloPublicId)

/** The pages' reads and writes are dropped: the fixture is all the data there is. */
const keepLocal = <M>(commands: ReadonlyArray<Command.Command<M, never, Resources>> | undefined) =>
	Arr.filter(commands ?? [], (command) => !/^(Fetch|Toggle|Delete|Save|Read)/.test(command.name))

const fold = <PM, PS>(
	model: PM,
	messages: ReadonlyArray<PS>,
	step: (model: PM, message: PS) => { readonly model: PM },
): PM => Arr.reduce(messages, model, (current, message) => step(current, message).model)

const INCIDENT = burnIncidentRow()

const PAYMENTS_RULE = "0199a002-0000-7000-8000-00000000000a"
const PAYMENTS = checkoutSlo({
	id: sloUuid(3),
	name: "Payments webhooks",
	alert_rule_id: PAYMENTS_RULE,
	service_name: "payments",
	environments: ["production", "eu-production"],
	sli: { type: "latency", threshold_ms: 1000 },
	target_percent: 99,
	window_days: 7,
})
const LOW_TARGET = lowTargetSlo()
/** Its environment is a typo for `production`, so it counts nothing. */
const SIGNUP = checkoutSlo({
	id: sloUuid(5),
	name: "Signup flow",
	alert_rule_id: "0199a002-0000-7000-8000-00000000000b",
	service_name: "signup",
	environments: ["prod"],
})

/** The tab's open incidents: a burn on two SLOs, and the payments SLO's spent budget alone. */
const HUB_INCIDENTS = [
	INCIDENT,
	budgetIncidentRow({ rule_id: PAYMENTS_RULE, rule_name: sloRuleName(PAYMENTS.name) }),
	burnIncidentRow({
		id: "0199a003-0000-7000-8000-000000000003",
		rule_id: LOW_TARGET.alert_rule_id ?? "",
		rule_name: sloRuleName(LOW_TARGET.name),
		threshold: 8,
		last_observed_value: 8.3,
	}),
]

const hubFor = (state: LabState) => {
	const entered = HubUpdate.init(hubAt({ tab: "slos" }), CONTEXT).model
	const rows =
		state === "tab-empty"
			? []
			: [
					{ slo: checkoutSlo(), status: sloStatus("burning") },
					{
						slo: searchSlo(),
						status: sloStatus("healthy", { sloId: sloUuid(2), targetPercent: 99.5 }),
					},
					{
						slo: PAYMENTS,
						status: sloStatus("exhausted", { sloId: sloUuid(3), targetPercent: 99 }),
					},
					{
						slo: LOW_TARGET,
						status: sloStatus("capped", { sloId: LOW_TARGET.id, targetPercent: 90 }),
					},
					{ slo: SIGNUP, status: sloStatus("no-data", { sloId: SIGNUP.id }) },
				]
	return fold(
		entered,
		[
			HubMessage.Message.ReadClock({ nowMs: NOW }),
			HubMessage.Message.CompletedFetchSession({ orgId: ORG, grants: GRANTS }),
			HubMessage.Message.UpdatedIncidents({ orgId: ORG, rows: HUB_INCIDENTS }),
			HubMessage.Message.CompletedFetchSlos({
				key: entered.slos.key ?? "",
				result: Result.succeed(rows),
			}),
		],
		(model, message) => HubUpdate.update(model, message, CONTEXT),
	)
}

const RESOLVED = {
	...INCIDENT,
	status: "resolved",
	severity: "warning",
	resolved_at: INCIDENT.last_triggered_at,
}

type SloPageFixture = Readonly<{
	slo: ReturnType<typeof checkoutSlo>
	scenario: SloScenario
	incidents: ReadonlyArray<typeof INCIDENT>
}>

/** The SLO, its figures and its incidents for a state of the SLO page. */
const pageFixture = (state: LabState): SloPageFixture => {
	const checkout = { slo: checkoutSlo(), incidents: [RESOLVED] }
	switch (state) {
		case "burning":
		case "holding":
			return { ...checkout, scenario: state, incidents: [INCIDENT] }
		case "slow":
			return {
				...checkout,
				scenario: "slow",
				incidents: [burnIncidentRow({ severity: "warning", threshold: 3, last_observed_value: 3.2 })],
			}
		case "low-target":
			return { slo: LOW_TARGET, scenario: "capped", incidents: HUB_INCIDENTS }
		case "sparse":
			return { ...checkout, scenario: "sparse", incidents: [] }
		case "no-data":
			return { slo: SIGNUP, scenario: "no-data", incidents: [] }
		case "exhausted":
			return { ...checkout, scenario: "exhausted" }
		case "budget-spent":
			return { ...checkout, scenario: "exhausted", incidents: [budgetIncidentRow(), RESOLVED] }
		case "burning-spent":
			return { ...checkout, scenario: "spent-burning", incidents: [INCIDENT, budgetIncidentRow()] }
		default:
			return { ...checkout, scenario: "healthy" }
	}
}

const sloFor = (state: LabState) => {
	const { slo, scenario, incidents } = pageFixture(state)
	const figures = { sloId: slo.id, targetPercent: slo.target_percent }
	const entered = SloUpdate.init({ _tag: "AlertsSlo", sloId: publicId(slo.id), search: {} }, CONTEXT).model
	const base = [
		SloMessage.Message.ReadClock({ nowMs: NOW }),
		SloMessage.Message.CompletedFetchSession({ orgId: ORG, grants: GRANTS }),
	]
	if (state === "loading")
		return fold(entered, base, (model, message) => SloUpdate.update(model, message, CONTEXT))
	return fold(
		entered,
		[
			...base,
			SloMessage.Message.CompletedFetchSlo({ key: entered.slo.key ?? "", result: Result.succeed(slo) }),
			SloMessage.Message.CompletedFetchStatus({
				key: entered.status.key ?? "",
				result:
					state === "status-error"
						? Result.fail(toLoadFailure(new Error("The warehouse query timed out.")))
						: Result.succeed(sloStatus(scenario, figures)),
			}),
			SloMessage.Message.CompletedFetchHistory({
				key: entered.history.key ?? "",
				result: Result.succeed(sloHistory(scenario, { ...figures, days: slo.window_days })),
			}),
			SloMessage.Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
			state === "incidents-unavailable"
				? SloMessage.Message.FailedLoadIncidents({ orgId: ORG })
				: SloMessage.Message.UpdatedIncidents({ orgId: ORG, rows: [...incidents] }),
		],
		(model, message) => SloUpdate.update(model, message, CONTEXT),
	)
}

const formFor = (state: LabState) => {
	const slo = searchSlo({ target_percent: 99.7 })
	const entered = FormUpdate.init(
		{ _tag: "AlertsSloNew", search: state === "form-edit" ? { sloId: publicId(slo.id) } : {} },
		CONTEXT,
	).model
	const common = [
		FormMessage.Message.CompletedFetchSession({ orgId: ORG, grants: GRANTS }),
		FormMessage.Message.CompletedFetchServices({ services: ["checkout", "search", "payments"] }),
		FormMessage.Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
	]
	const extra =
		state === "form-edit"
			? [
					FormMessage.Message.CompletedFetchExisting({
						key: entered.existing.key ?? "",
						result: Result.succeed(slo),
					}),
				]
			: state === "form-invalid"
				? [
						FormMessage.Message.ChangedText({ field: "environments", value: "production" }),
						FormMessage.Message.PickedTarget({ target: "custom" }),
						FormMessage.Message.ChangedText({ field: "customTarget", value: "100" }),
					]
				: [
						FormMessage.Message.ChangedText({ field: "name", value: "Checkout API" }),
						FormMessage.Message.ChangedText({ field: "serviceName", value: "checkout" }),
						FormMessage.Message.ChangedText({ field: "environments", value: "production" }),
						// A 90% target tops out at 10x, so the alerting lines read the capped factors.
						...(state === "form-low-target"
							? [
									FormMessage.Message.PickedTarget({ target: "custom" }),
									FormMessage.Message.ChangedText({ field: "customTarget", value: "90" }),
								]
							: []),
					]
	return fold(entered, [...common, ...extra], (model, message) =>
		FormUpdate.update(model, message, CONTEXT),
	)
}

export const init = (flags: Flags): Return => {
	const slo = sloFor(flags.state)
	return {
		model: { state: flags.state, hub: hubFor(flags.state), slo, form: formFor(flags.state) },
		// The SLO page's chart runtime still loads, so its charts draw.
		commands: Command.mapMessages(
			Arr.filter(
				SloUpdate.init({ _tag: "AlertsSlo", sloId: publicId(checkoutSlo().id), search: {} }, CONTEXT)
					.commands ?? [],
				(command) => command.name === "LoadChartRuntime",
			),
			(message) => Message.GotSloMessage({ message }),
		),
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
		GotSloMessage: ({ message: child }) => {
			const next = SloUpdate.update(model.slo, child, CONTEXT)
			return {
				model: { ...model, slo: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotSloMessage({ message: inner }),
				),
			}
		},
		GotFormMessage: ({ message: child }) => {
			const next = FormUpdate.update(model.form, child, CONTEXT)
			return {
				model: { ...model, form: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotFormMessage({ message: inner }),
				),
			}
		},
	})

const isTab = (state: LabState) => state === "tab" || state === "tab-empty"
const isForm = (state: LabState) =>
	state === "form-new" || state === "form-low-target" || state === "form-invalid" || state === "form-edit"

export const breadcrumbs = (model: Model) =>
	isTab(model.state)
		? hubBreadcrumbs(model.hub)
		: isForm(model.state)
			? [{ label: "Alerts" }, { label: "SLOs" }]
			: breadcrumbsOf()

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	isTab(model.state)
		? h.submodel({
				slotId: "lab-slos-hub",
				model: model.hub,
				view: hubView,
				viewInputs: { context: CONTEXT },
				toParentMessage: (message: HubMessage.Message) => Message.GotHubMessage({ message }),
			})
		: isForm(model.state)
			? h.submodel({
					slotId: "lab-slos-form",
					model: model.form,
					view: formView,
					viewInputs: { context: CONTEXT },
					toParentMessage: (message: FormMessage.Message) => Message.GotFormMessage({ message }),
				})
			: h.submodel({
					slotId: "lab-slos-page",
					model: model.slo,
					view: sloView,
					viewInputs: { context: CONTEXT },
					toParentMessage: (message: SloMessage.Message) => Message.GotSloMessage({ message }),
				})
