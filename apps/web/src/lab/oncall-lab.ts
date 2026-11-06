import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { zonedDayStart } from "@maple/views/ui/shift-timeline"
import { Effect, Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Menu from "@maple/views/ui/menu"
import * as HubMessage from "../page/alerts/hub/message"
import * as HubModel from "../page/alerts/hub/model"
import * as HubUpdate from "../page/alerts/hub/update"
import { view as hubView } from "../page/alerts/hub/view"
import * as IncidentMessage from "../page/alerts/incident/message"
import * as IncidentModel from "../page/alerts/incident/model"
import * as IncidentUpdate from "../page/alerts/incident/update"
import { breadcrumbsOf as incidentBreadcrumbs, view as incidentView } from "../page/alerts/incident/view"
import * as FormMessage from "../page/alerts/schedule-form/message"
import * as FormModel from "../page/alerts/schedule-form/model"
import * as FormUpdate from "../page/alerts/schedule-form/update"
import { view as formView } from "../page/alerts/schedule-form/view"
import * as ScheduleMessage from "../page/alerts/schedule/message"
import * as ScheduleModel from "../page/alerts/schedule/model"
import * as ScheduleUpdate from "../page/alerts/schedule/update"
import { breadcrumbsOf as scheduleBreadcrumbs, view as scheduleView } from "../page/alerts/schedule/view"
import { chainDestinations, chainUuid } from "../page/alerts/shared/escalation-test-fixtures"
import {
	checkoutOverrides,
	checkoutSchedule,
	checkoutShifts,
	DST_NOW,
	memberId,
	mixedTargetChain,
	ONCALL_NOW,
	oncallMembers,
	pagedEvents,
	populatedSchedules,
	schedulePublicId,
} from "../page/alerts/shared/oncall-test-fixtures"
import { incidentRow, INCIDENT_ID, ORG, ruleRow } from "../page/alerts/shared/test-rows"
import type { PageContext } from "../page/contract"
import type { Resources } from "../platform/resources"
import { isoMs } from "../page/alerts/shared/time"

// `/lab/oncall`: on-call schedules in the hub (the On-call tab and the inbox's "On call now"
// strip), the schedule form, the calendar with overrides and a DST week, the chain dialog with
// people and schedules, and an incident timeline with pages. `?state=` picks one.

export const LabState = Schema.Literals([
	"schedules-empty",
	"schedules",
	"strip",
	"editor-new",
	"editor-edit",
	"editor-invalid",
	"editor-error",
	"calendar",
	"calendar-dst",
	"override-dialog",
	"chain-dialog",
	"incident-paged",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "schedules",
	),
}))

export const Model = Schema.Struct({
	state: LabState,
	hub: HubModel.Model,
	form: FormModel.Model,
	schedule: ScheduleModel.Model,
	incident: IncidentModel.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotHubMessage: { message: HubMessage.Message },
	GotFormMessage: { message: FormMessage.Message },
	GotScheduleMessage: { message: ScheduleMessage.Message },
	GotIncidentMessage: { message: IncidentMessage.Message },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>
type Step<PM, PS> = Readonly<{ model: PM; commands?: ReadonlyArray<Command.Command<PS, never, Resources>> }>

/** The schedule is shown in Berlin; the viewer reads UTC, so the calendar notes both. */
const CONTEXT: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const GRANTS = Policy.grantsOf(["org:engineer"])

/** Reads and writes are dropped: the fixture is all the data there is. */
const keepLocal = <M>(commands: ReadonlyArray<Command.Command<M, never, Resources>> | undefined) =>
	Arr.filter(
		commands ?? [],
		(command) => !/^(Fetch|Toggle|Delete|Save|Read|Create|Generate)/.test(command.name),
	)

const fold = <PM, PS>(
	start: Step<PM, PS>,
	messages: ReadonlyArray<PS>,
	step: (model: PM, message: PS) => Step<PM, PS>,
): Step<PM, PS> =>
	Arr.reduce(messages, { model: start.model, commands: keepLocal(start.commands) }, (current, message) => {
		const next = step(current.model, message)
		return { model: next.model, commands: [...(current.commands ?? []), ...keepLocal(next.commands)] }
	})

const failure = (message: string): LoadFailure => ({
	_tag: "@maple/http/errors/AlertValidationError",
	type: "invalid_request_error",
	code: "invalid_request",
	title: "Invalid request",
	message,
	retryable: false,
	recovery: "fix_request",
})

// HUB

const hubStep = (model: HubModel.Model, message: HubMessage.Message) =>
	HubUpdate.update(model, message, CONTEXT)

const hubFor = (state: LabState): Step<HubModel.Model, HubMessage.Message> => {
	const tab = state === "strip" ? "inbox" : state === "chain-dialog" ? "routing" : "oncall"
	const entered = HubUpdate.init({ _tag: "Alerts", search: { tab } }, CONTEXT).model
	const schedules = state === "schedules-empty" ? [] : populatedSchedules(ONCALL_NOW)
	const chains = [mixedTargetChain(chainDestinations[0]?.id ?? "")]
	return fold(
		{ model: entered },
		[
			HubMessage.Message.ReadClock({ nowMs: ONCALL_NOW }),
			HubMessage.Message.CompletedFetchSession({ orgId: ORG, grants: GRANTS }),
			HubMessage.Message.CompletedFetchMembers({ result: Result.succeed(oncallMembers) }),
			HubMessage.Message.UpdatedDestinations({ orgId: ORG, rows: chainDestinations }),
			HubMessage.Message.UpdatedRules({
				orgId: ORG,
				rows: [ruleRow(1, { name: "Checkout error rate" }), ruleRow(2)],
			}),
			HubMessage.Message.UpdatedRuleStates({ orgId: ORG, rows: [] }),
			HubMessage.Message.UpdatedIncidents({
				orgId: ORG,
				rows: [incidentRow({ rule_name: "Checkout p95 latency" })],
			}),
			HubMessage.Message.CompletedFetchSchedules({
				key: entered.schedules.key ?? "",
				readAtMs: ONCALL_NOW,
				result: Result.succeed(schedules),
			}),
			HubMessage.Message.CompletedFetchRoutingDeliveries({
				key: entered.routingDeliveries.key ?? "",
				result: Result.succeed([]),
			}),
			HubMessage.Message.CompletedFetchDeliveries({
				key: entered.deliveries.key ?? "",
				result: Result.succeed([]),
			}),
			HubMessage.Message.CompletedFetchChains({
				key: entered.chains.key ?? "",
				result: Result.succeed(chains),
			}),
			...(state === "chain-dialog"
				? [
						HubMessage.Message.GotRowMenuMessage({
							menuId: `chain:${chainUuid(1)}`,
							message: Menu.Message.ClickedItem({
								index: 0,
								item: { kind: "Item", value: "edit" },
							}),
						}),
					]
				: []),
		],
		hubStep,
	)
}

// FORM

const formStep = (model: FormModel.Model, message: FormMessage.Message) =>
	FormUpdate.update(model, message, CONTEXT)

const formFor = (state: LabState): Step<FormModel.Model, FormMessage.Message> => {
	const isEdit = state === "editor-edit" || state === "editor-error"
	const start = FormUpdate.init(
		{ _tag: "AlertsScheduleNew", search: isEdit ? { scheduleId: schedulePublicId(1) } : {} },
		CONTEXT,
	)
	const base = [
		FormMessage.Message.ReadDefaults({
			timeZone: "Europe/Berlin",
			nowMs: ONCALL_NOW,
			zones: Intl.supportedValuesOf("timeZone"),
		}),
		FormMessage.Message.CompletedFetchMembers({ result: Result.succeed(oncallMembers) }),
		FormMessage.Message.CompletedFetchSession({ orgId: ORG, grants: GRANTS }),
		...(isEdit
			? [
					FormMessage.Message.CompletedFetchExisting({
						key: start.model.existing.key ?? "",
						result: Result.succeed(checkoutSchedule(ONCALL_NOW)),
					}),
				]
			: []),
	]
	const extra: ReadonlyArray<FormMessage.Message> =
		state === "editor-invalid"
			? [
					FormMessage.Message.ChangedLayerText({ key: "l0", field: "handoffTime", value: "" }),
					FormMessage.Message.ClickedAddRestriction({ key: "l0" }),
					FormMessage.Message.ToggledRestrictionDay({
						key: "l0",
						restrictionKey: "r1",
						weekday: "mon",
					}),
					FormMessage.Message.ToggledRestrictionDay({
						key: "l0",
						restrictionKey: "r1",
						weekday: "tue",
					}),
					FormMessage.Message.ToggledRestrictionDay({
						key: "l0",
						restrictionKey: "r1",
						weekday: "wed",
					}),
					FormMessage.Message.ToggledRestrictionDay({
						key: "l0",
						restrictionKey: "r1",
						weekday: "thu",
					}),
					FormMessage.Message.ToggledRestrictionDay({
						key: "l0",
						restrictionKey: "r1",
						weekday: "fri",
					}),
					FormMessage.Message.ClickedSave(),
				]
			: state === "editor-error"
				? [
						FormMessage.Message.ClickedSave(),
						FormMessage.Message.CompletedSave({
							result: Result.fail(
								failure("Omar Haddad is no longer a member of this organization."),
							),
						}),
					]
				: state === "editor-new"
					? [FormMessage.Message.ChangedName({ value: "Checkout primary" })]
					: []
	return fold(start, [...base, ...extra], formStep)
}

// SCHEDULE PAGE

const scheduleStep = (model: ScheduleModel.Model, message: ScheduleMessage.Message) =>
	ScheduleUpdate.update(model, message, CONTEXT)

const scheduleFor = (state: LabState): Step<ScheduleModel.Model, ScheduleMessage.Message> => {
	const nowMs = state === "calendar-dst" ? DST_NOW : ONCALL_NOW
	const start = ScheduleUpdate.init(
		{ _tag: "AlertsSchedule", scheduleId: schedulePublicId(1), search: {} },
		CONTEXT,
	)
	const schedule = checkoutSchedule(nowMs)
	const loaded = fold(
		start,
		[
			ScheduleMessage.Message.CompletedFetchMembers({ result: Result.succeed(oncallMembers) }),
			ScheduleMessage.Message.CompletedFetchSession({ orgId: ORG, grants: GRANTS }),
			ScheduleMessage.Message.ReadClock({ nowMs }),
			ScheduleMessage.Message.CompletedFetchSchedule({
				key: start.model.schedule.key ?? "",
				result: Result.succeed(schedule),
			}),
			ScheduleMessage.Message.CompletedFetchOverrides({
				key: start.model.overrides.key ?? "",
				result: Result.succeed(checkoutOverrides(nowMs)),
			}),
		],
		scheduleStep,
	)
	const fromMs = zonedDayStart(nowMs, schedule.time_zone)
	const toMs = zonedDayStart(nowMs, schedule.time_zone, ScheduleUpdate.CALENDAR_DAYS)
	const withShifts = fold(
		loaded,
		[
			ScheduleMessage.Message.CompletedFetchShifts({
				key: loaded.model.shifts.key ?? "",
				result: Result.succeed(checkoutShifts(nowMs, fromMs, toMs)),
			}),
		],
		scheduleStep,
	)
	return state === "override-dialog"
		? fold(
				withShifts,
				[
					ScheduleMessage.Message.ClickedShift({
						startMs: fromMs + 33 * 3_600_000,
						endMs: fromMs + 41 * 3_600_000,
					}),
					ScheduleMessage.Message.ChangedOverrideUser({ value: memberId(7) }),
				],
				scheduleStep,
			)
		: withShifts
}

// INCIDENT

const incidentStep = (model: IncidentModel.Model, message: IncidentMessage.Message) =>
	IncidentUpdate.update(model, message, CONTEXT)

const incidentFor = (): Step<IncidentModel.Model, IncidentMessage.Message> => {
	const start = IncidentUpdate.init({ _tag: "AlertIncident", incidentId: INCIDENT_ID, search: {} }, CONTEXT)
	const row = incidentRow({ rule_name: "Checkout p95 latency" })
	const synced = fold(
		start,
		[
			IncidentMessage.Message.ReadClock({ nowMs: isoMs(row.first_triggered_at) + 20 * 60_000 }),
			IncidentMessage.Message.UpdatedIncidents({ orgId: ORG, rows: [row] }),
			IncidentMessage.Message.UpdatedRules({
				orgId: ORG,
				rows: [ruleRow(2, { name: "Checkout p95 latency" })],
			}),
			IncidentMessage.Message.UpdatedRuleStates({ orgId: ORG, rows: [] }),
		],
		incidentStep,
	)
	return fold(
		synced,
		[
			IncidentMessage.Message.CompletedFetchActivity({
				key: synced.model.activity.key ?? "",
				result: Result.succeed(pagedEvents(INCIDENT_ID, isoMs(row.first_triggered_at))),
			}),
			IncidentMessage.Message.CompletedFetchEscalation({
				key: synced.model.escalation.key ?? "",
				result: Result.succeed(null),
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
}

const isHub = (state: LabState) =>
	state === "schedules" || state === "schedules-empty" || state === "strip" || state === "chain-dialog"
const isForm = (state: LabState) => Str.startsWith("editor-")(state)
const isSchedule = (state: LabState) => Str.startsWith("calendar")(state) || state === "override-dialog"

export const init = (flags: Flags): Return => {
	const hub = hubFor(flags.state)
	const form = formFor(flags.state)
	const schedule = scheduleFor(flags.state)
	const incident = incidentFor()
	return {
		model: {
			state: flags.state,
			hub: hub.model,
			form: form.model,
			schedule: schedule.model,
			incident: incident.model,
		},
		commands: [
			...(isHub(flags.state)
				? Command.mapMessages(hub.commands ?? [], (message) => Message.GotHubMessage({ message }))
				: []),
			...(isForm(flags.state)
				? Command.mapMessages(form.commands ?? [], (message) => Message.GotFormMessage({ message }))
				: []),
			...(isSchedule(flags.state)
				? Command.mapMessages(schedule.commands ?? [], (message) =>
						Message.GotScheduleMessage({ message }),
					)
				: []),
			...(flags.state === "incident-paged"
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
		GotFormMessage: ({ message: child }) => {
			const next = FormUpdate.update(model.form, child, CONTEXT)
			return {
				model: { ...model, form: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotFormMessage({ message: inner }),
				),
			}
		},
		GotScheduleMessage: ({ message: child }) => {
			const next = ScheduleUpdate.update(model.schedule, child, CONTEXT)
			return {
				model: { ...model, schedule: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotScheduleMessage({ message: inner }),
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
		? [{ label: "Alerts" }]
		: isForm(model.state)
			? [{ label: "Alerts", href: "/alerts" }, { label: "On-call" }]
			: isSchedule(model.state)
				? scheduleBreadcrumbs()
				: incidentBreadcrumbs(model.incident)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	isHub(model.state)
		? h.submodel({
				slotId: "lab-oncall-hub",
				model: model.hub,
				view: hubView,
				viewInputs: { context: CONTEXT },
				toParentMessage: (message: HubMessage.Message) => Message.GotHubMessage({ message }),
			})
		: isForm(model.state)
			? h.submodel({
					slotId: "lab-oncall-form",
					model: model.form,
					view: formView,
					viewInputs: { context: CONTEXT },
					toParentMessage: (message: FormMessage.Message) => Message.GotFormMessage({ message }),
				})
			: isSchedule(model.state)
				? h.submodel({
						slotId: "lab-oncall-schedule",
						model: model.schedule,
						view: scheduleView,
						viewInputs: { context: CONTEXT },
						toParentMessage: (message: ScheduleMessage.Message) =>
							Message.GotScheduleMessage({ message }),
					})
				: h.submodel({
						slotId: "lab-oncall-incident",
						model: model.incident,
						view: incidentView,
						viewInputs: { context: CONTEXT },
						toParentMessage: (message: IncidentMessage.Message) =>
							Message.GotIncidentMessage({ message }),
					})
