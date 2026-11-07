import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { AlertSilenceId } from "@maple/domain/http"
import type { V2AlertSilence } from "@maple/domain/http/v2"
import { Effect, Option, Result, Schema, Array as Arr } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as HubMessage from "../page/alerts/hub/message"
import * as HubModel from "../page/alerts/hub/model"
import * as HubUpdate from "../page/alerts/hub/update"
import { breadcrumbs as hubBreadcrumbs, view as hubView } from "../page/alerts/hub/view"
import * as SilenceDialog from "../page/alerts/silence-dialog/dialog"
import { destinationRow, NOW, ORG, ruleRow, stateRow } from "../page/alerts/shared/test-rows"
import type { PageContext } from "../page/contract"
import type { Resources } from "../platform/resources"

// `/lab/alerts-hub`: the hub's Inbox, Rules and Silences tabs and the silence dialog over
// fixtures, including a rule skipped for too few samples and a cancelled silence. `?state=` picks
// one: inbox, rules, loading, error, silences, silence-dialog, silence-dialog-custom.

export const LabState = Schema.Literals([
	"inbox",
	"rules",
	"loading",
	"error",
	"silences",
	"silence-dialog",
	"silence-dialog-custom",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "inbox",
	),
}))

export const Model = Schema.Struct({ state: LabState, hub: HubModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotHubMessage: { message: HubMessage.Message } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)(ORG),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const GRANTS = Policy.grantsOf(["org:engineer"])

/** The hub's reads and writes are dropped: the fixture is all the data there is. */
const keepLocal = <M>(commands: ReadonlyArray<Command.Command<M, never, Resources>> | undefined) =>
	Arr.filter(commands ?? [], (command) => !/^(Fetch|Toggle|Delete|Save|Read|End)/.test(command.name))

const MINUTE = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

const RULES = [
	// Over its threshold on 4 of the 20 samples it needs: every window is skipped and can't fire.
	ruleRow(1, {
		name: "Checkout error rate",
		signal_type: "error_rate",
		threshold: 0.05,
		minimum_sample_count: 20,
		service_names_json: ["checkout"],
	}),
	ruleRow(2, { name: "Payments p95 latency", threshold: 800 }),
	ruleRow(3, {
		name: "Search apdex",
		signal_type: "apdex",
		comparator: "lt",
		threshold: 0.9,
		apdex_threshold_ms: 500,
		service_names_json: ["search"],
	}),
	ruleRow(4, { name: "Batch export throughput", signal_type: "throughput", threshold: 5000 }),
	// A floor with a quarter of its threshold to spare: healthy, so not drawn as near firing.
	ruleRow(5, {
		name: "Orders throughput floor",
		signal_type: "throughput",
		comparator: "lt",
		threshold: 500,
		service_names_json: ["orders"],
	}),
]

const STATES = [
	stateRow(1, { last_status: "skipped", last_value: 0.063, last_sample_count: 4, consecutive_healthy: 0 }),
	stateRow(2, { last_value: 650 }),
	stateRow(3, { last_value: 0.97 }),
	stateRow(4, { last_status: "skipped", last_value: null, last_sample_count: 0, consecutive_healthy: 0 }),
	stateRow(5, { last_value: 630 }),
]

const silence = (
	id: string,
	reason: string,
	startMin: number,
	endMin: number,
	matchers: V2AlertSilence["matchers"],
): V2AlertSilence => ({
	id: Schema.decodeSync(AlertSilenceId)(id),
	object: "alert_silence",
	reason,
	matchers,
	status: endMin <= 0 ? "ended" : startMin > 0 ? "scheduled" : "active",
	starts_at: iso(NOW + startMin * MINUTE),
	ends_at: iso(NOW + endMin * MINUTE),
	maintenance_window_id: null,
	created_by: "user_ada",
	created_at: iso(NOW - 3 * 60 * MINUTE),
	updated_at: iso(NOW),
})

const SILENCES = [
	silence("11111111-1111-4111-8111-111111111111", "Deploying checkout v2.3", -20, 40, {
		services: ["checkout"],
	}),
	silence("22222222-2222-4222-8222-222222222222", "Database migration", 180, 240, { tags: ["db"] }),
	// Cancelled before it started: the API collapses its window to one instant.
	silence("33333333-3333-4333-8333-333333333333", "Load test on staging", -45, -45, {
		environments: ["staging"],
	}),
	silence("44444444-4444-4444-8444-444444444444", "Payments provider outage", -300, -120, {
		services: ["payments"],
	}),
]

const tabOf = (state: LabState) =>
	state === "rules"
		? "rules"
		: state === "inbox" || state === "loading" || state === "error"
			? "inbox"
			: "silences"

const step = (model: HubModel.Model, message: HubMessage.Message) => HubUpdate.update(model, message, CONTEXT)

const hubFor = (state: LabState): HubModel.Model => {
	const entered = HubUpdate.init({ _tag: "Alerts", search: { tab: tabOf(state) } }, CONTEXT).model
	const base = [
		HubMessage.Message.ReadClock({ nowMs: NOW }),
		HubMessage.Message.CompletedFetchSession({ orgId: ORG, grants: GRANTS }),
	]
	const data =
		state === "loading"
			? []
			: state === "error"
				? [HubMessage.Message.FailedLoadAlerts({ orgId: ORG })]
				: [
						HubMessage.Message.UpdatedRules({ orgId: ORG, rows: RULES }),
						HubMessage.Message.UpdatedRuleStates({ orgId: ORG, rows: STATES }),
						HubMessage.Message.UpdatedIncidents({ orgId: ORG, rows: [] }),
						HubMessage.Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
						HubMessage.Message.CompletedFetchSilences({
							key: entered.silences.key ?? "",
							result: Result.succeed(SILENCES),
						}),
					]
	return Arr.reduce([...base, ...data], entered, (model, message) => step(model, message).model)
}

const toLab = (
	next: Readonly<{ commands?: ReadonlyArray<Command.Command<HubMessage.Message, never, Resources>> }>,
) => Command.mapMessages(keepLocal(next.commands), (message) => Message.GotHubMessage({ message }))

export const init = (flags: Flags): Return => {
	const hub = hubFor(flags.state)
	if (flags.state !== "silence-dialog" && flags.state !== "silence-dialog-custom")
		return { model: { state: flags.state, hub } }
	// The dialog opens through its own commands, so they run here rather than in the fold.
	const opened = step(hub, HubMessage.Message.ClickedNewSilence())
	const picked =
		flags.state === "silence-dialog-custom"
			? step(
					opened.model,
					HubMessage.Message.GotSilenceDialogMessage({
						message: SilenceDialog.Message.ChangedDuration({ duration: "custom" }),
					}),
				)
			: { model: opened.model, commands: [] }
	return {
		model: { state: flags.state, hub: picked.model },
		commands: [...toLab(opened), ...toLab(picked)],
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotHubMessage: ({ message: child }) => {
			const next = step(model.hub, child)
			return { model: { ...model, hub: next.model }, commands: toLab(next) }
		},
	})

export const breadcrumbs = (model: Model) => hubBreadcrumbs(model.hub)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "lab-alerts-hub",
		model: model.hub,
		view: hubView,
		viewInputs: { context: CONTEXT },
		toParentMessage: (message: HubMessage.Message) => Message.GotHubMessage({ message }),
	})
