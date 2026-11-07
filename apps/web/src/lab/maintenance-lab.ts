import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { Effect, Option, Result, Schema, Array as Arr } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as WindowDialog from "../page/alerts/maintenance-dialog/dialog"
import * as HubMessage from "../page/alerts/hub/message"
import * as HubModel from "../page/alerts/hub/model"
import * as HubUpdate from "../page/alerts/hub/update"
import { breadcrumbs as hubBreadcrumbs, view as hubView } from "../page/alerts/hub/view"
import {
	populatedWindows,
	silencesWithWindows,
	weeklyWindow,
} from "../page/alerts/shared/maintenance-test-fixtures"
import { windowPublicId } from "../page/alerts/shared/maintenance-windows"
import { NOW, ORG, ruleRow } from "../page/alerts/shared/test-rows"
import type { PageContext } from "../page/contract"
import type { Resources } from "../platform/resources"
import { keepLocal } from "./local-commands"

// `/lab/maintenance`: the alerts hub's Maintenance tab, its dialog and the Silences tab filtered
// to one window, over fixtures. `?state=` picks one.

export const LabState = Schema.Literals([
	"list",
	"empty",
	"dialog-weekly",
	"dialog-once-invalid",
	"silences",
	"silences-filtered",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "list",
	),
}))

export const Model = Schema.Struct({ state: LabState, hub: HubModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotHubMessage: { message: HubMessage.Message } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>
type Step = Readonly<{
	model: HubModel.Model
	commands?: ReadonlyArray<Command.Command<HubMessage.Message, never, Resources>>
}>

const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)(ORG),
	pinnedNamespace: null,
	timeZone: "Europe/Berlin",
}
const GRANTS = Policy.grantsOf(["org:engineer"])
const RULES = [ruleRow(1, { name: "Checkout error rate" }), ruleRow(2, { name: "Payments p95 latency" })]
const ZONES = ["Europe/Berlin", "Europe/London", "America/New_York", "Asia/Tokyo", "UTC"]

const hubStep = (model: HubModel.Model, message: HubMessage.Message) =>
	HubUpdate.update(model, message, CONTEXT)

/** Runs messages through the hub, keeping only its local commands (a dialog's open animation). */
const fold = (start: HubModel.Model, messages: ReadonlyArray<HubMessage.Message>): Step => {
	const initial: Step = { model: start, commands: [] }
	return Arr.reduce(messages, initial, (current, message) => {
		const next = hubStep(current.model, message)
		return { model: next.model, commands: [...(current.commands ?? []), ...keepLocal(next.commands)] }
	})
}

const dialog = (message: WindowDialog.Message) => HubMessage.Message.GotWindowDialogMessage({ message })

const searchFor = (state: LabState): HubModel.Model["search"] =>
	state === "silences"
		? { tab: "silences" }
		: state === "silences-filtered"
			? { tab: "silences", window: windowPublicId(weeklyWindow.id) }
			: { tab: "maintenance" }

const extraFor = (state: LabState): ReadonlyArray<HubMessage.Message> =>
	state === "dialog-weekly"
		? [
				HubMessage.Message.ClickedNewWindow(),
				dialog(WindowDialog.Message.ReadZones({ zones: ZONES })),
				dialog(WindowDialog.Message.ChangedName({ value: "Nightly database backup" })),
				dialog(
					WindowDialog.Message.ChangedMatcher({ field: "services", value: "checkout, payments" }),
				),
				dialog(WindowDialog.Message.ChangedMatcher({ field: "environments", value: "production" })),
				dialog(WindowDialog.Message.ToggledDay({ day: "mon" })),
				dialog(WindowDialog.Message.ToggledDay({ day: "thu" })),
				dialog(WindowDialog.Message.ChangedReason({ value: "Snapshot and vacuum" })),
			]
		: state === "dialog-once-invalid"
			? [
					HubMessage.Message.ClickedNewWindow(),
					dialog(WindowDialog.Message.ReadZones({ zones: ZONES })),
					dialog(WindowDialog.Message.ChangedName({ value: "Datacenter move" })),
					dialog(WindowDialog.Message.ChangedKind({ kind: "once" })),
					dialog(WindowDialog.Message.ChangedStartsAt({ value: "2026-10-03T22:00" })),
					dialog(WindowDialog.Message.ChangedEndsAt({ value: "2026-10-03T20:00" })),
					dialog(WindowDialog.Message.ClickedSave()),
				]
			: []

const hubFor = (state: LabState): Step => {
	const entered = HubUpdate.init({ _tag: "Alerts", search: searchFor(state) }, CONTEXT).model
	const windows = state === "empty" ? [] : populatedWindows
	return fold(entered, [
		HubMessage.Message.ReadClock({ nowMs: NOW }),
		HubMessage.Message.CompletedFetchSession({ orgId: ORG, grants: GRANTS }),
		HubMessage.Message.UpdatedRules({ orgId: ORG, rows: RULES }),
		HubMessage.Message.CompletedFetchWindows({
			key: entered.windows.key ?? "",
			result: Result.succeed(windows),
		}),
		...(entered.silences.key === undefined || entered.silences.key === null
			? []
			: [
					HubMessage.Message.CompletedFetchSilences({
						key: entered.silences.key,
						result: Result.succeed(silencesWithWindows),
					}),
				]),
		...extraFor(state),
	])
}

export const init = (flags: Flags): Return => {
	const hub = hubFor(flags.state)
	return {
		model: { state: flags.state, hub: hub.model },
		commands: Command.mapMessages(hub.commands ?? [], (message) => Message.GotHubMessage({ message })),
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotHubMessage: ({ message: child }) => {
			const next = hubStep(model.hub, child)
			return {
				model: { ...model, hub: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotHubMessage({ message: inner }),
				),
			}
		},
	})

export const breadcrumbs = (model: Model) => hubBreadcrumbs(model.hub)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "lab-maintenance-hub",
		model: model.hub,
		view: hubView,
		viewInputs: { context: CONTEXT },
		toParentMessage: (message: HubMessage.Message) => Message.GotHubMessage({ message }),
	})
