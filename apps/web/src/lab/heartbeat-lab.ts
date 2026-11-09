import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { UptimeMonitorPublicId } from "@maple/domain/http/v2"
import { Effect, Option, Result, Schema, Array as Arr } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext } from "../page/contract"
import { destinationRow } from "../page/alerts/shared/test-rows"
import type { UptimeMonitor } from "../page/alerts/shared/uptime-derive"
import { heartbeatMonitor } from "../page/alerts/shared/uptime-test-monitors"
import * as FormMessage from "../page/alerts/uptime-form/message"
import * as FormModel from "../page/alerts/uptime-form/model"
import * as FormUpdate from "../page/alerts/uptime-form/update"
import { view as formView } from "../page/alerts/uptime-form/view"
import * as MonitorMessage from "../page/alerts/uptime-monitor/message"
import * as MonitorModel from "../page/alerts/uptime-monitor/model"
import * as MonitorUpdate from "../page/alerts/uptime-monitor/update"
import { breadcrumbsOf, view as monitorView } from "../page/alerts/uptime-monitor/view"
import type { Resources } from "../platform/resources"

// `/lab/heartbeat`: a heartbeat monitor's create form and its page with the Ping URL panel, over
// fixtures. `?state=` picks one: form, monitor.

export const LabState = Schema.Literals(["form", "monitor"])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "form",
	),
}))

export const Model = Schema.Struct({
	state: LabState,
	form: FormModel.Model,
	monitor: MonitorModel.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotFormMessage: { message: FormMessage.Message },
	GotMonitorMessage: { message: MonitorMessage.Message },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const ORG = "org_lab_heartbeat"
const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)(ORG),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const GRANTS = Policy.grantsOf(["org:engineer"])
const publicId = Schema.encodeSync(UptimeMonitorPublicId)

const NOW_MS = Date.UTC(2026, 10, 9, 9, 15)
const DAY_MS = 86_400_000
const PING_URL = "https://api.maple.dev/hb/hb7Qm2xKp9VtR4cWn8LdZs3F"

/** The job's last 14 nightly runs: the ping lands when the export finishes, 3 to 14 minutes after 02:00. */
const nightlyPings = Array.from({ length: 14 }, (_, index) => {
	const day = Date.UTC(2026, 10, 9 - (13 - index), 2, 3 + ((index * 7) % 12), 18)
	return { at: new Date(day).toISOString(), ok: true, duration_ms: null }
})
const LAST_PING = nightlyPings[nightlyPings.length - 1]?.at ?? new Date(NOW_MS).toISOString()

const MONITOR: UptimeMonitor = {
	...heartbeatMonitor(),
	config: {
		type: "heartbeat",
		schedule: { type: "cron", expression: "0 2 * * *", timezone: "UTC" },
		grace_seconds: 1800,
	},
	heartbeat_url: PING_URL,
	destination_ids: [],
	state: {
		status: "up",
		consecutive_failures: 0,
		status_changed_at: new Date(NOW_MS - 21 * DAY_MS).toISOString(),
		last_check: {
			at: LAST_PING,
			ok: true,
			status_code: null,
			duration_ms: null,
			error: null,
			trace_id: null,
		},
		recent: nightlyPings,
		last_ping_at: LAST_PING,
	},
	created_at: new Date(NOW_MS - 21 * DAY_MS).toISOString(),
	updated_at: new Date(NOW_MS - 21 * DAY_MS).toISOString(),
}

/** The pages' reads and writes are dropped: the fixture is all the data there is. */
const keepLocal = <M>(commands: ReadonlyArray<Command.Command<M, never, Resources>> | undefined) =>
	Arr.filter(commands ?? [], (command) => !/^(Fetch|Toggle|Check|Save|Test|Read)/.test(command.name))

const fold = <PM, PS>(
	model: PM,
	messages: ReadonlyArray<PS>,
	step: (model: PM, message: PS) => { readonly model: PM },
): PM => Arr.reduce(messages, model, (current, message) => step(current, message).model)

/** A new Heartbeat filled in as the docs walk through it: a nightly job on cron, 30 minutes' grace. */
const filledForm = () => {
	const entered = FormUpdate.init({ _tag: "AlertsUptimeNew", search: { kind: "heartbeat" } }, CONTEXT).model
	return fold(
		entered,
		[
			FormMessage.Message.CompletedFetchSession({ orgId: ORG, grants: GRANTS }),
			FormMessage.Message.CompletedFetchServices({ services: ["billing", "checkout", "search"] }),
			FormMessage.Message.CompletedReadTimeZones({
				zones: ["UTC", "America/New_York", "Europe/Berlin", "Asia/Tokyo"],
			}),
			FormMessage.Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
			FormMessage.Message.ChangedText({ field: "name", value: "nightly-billing-export" }),
			FormMessage.Message.ChangedScheduleMode({ mode: "cron" }),
			FormMessage.Message.ChangedText({ field: "cronExpression", value: "0 2 * * *" }),
			FormMessage.Message.ChangedText({ field: "cronTimezone", value: "UTC" }),
			FormMessage.Message.ChangedText({ field: "graceValue", value: "30" }),
			FormMessage.Message.ChangedGraceUnit({ unit: "minutes" }),
		],
		(model, message) => FormUpdate.update(model, message, CONTEXT),
	)
}

const openedMonitor = () => {
	const entered = MonitorUpdate.init(
		{ _tag: "AlertsUptimeMonitor", monitorId: publicId(MONITOR.id), search: {} },
		CONTEXT,
	).model
	return fold(
		entered,
		[
			MonitorMessage.Message.ReadClock({ nowMs: NOW_MS }),
			MonitorMessage.Message.CompletedFetchSession({ orgId: ORG, grants: GRANTS }),
			MonitorMessage.Message.UpdatedDestinations({ orgId: ORG, rows: [] }),
			MonitorMessage.Message.UpdatedIncidents({ orgId: ORG, rows: [] }),
			MonitorMessage.Message.CompletedFetchMonitor({
				key: entered.monitor.key ?? "",
				result: Result.succeed(MONITOR),
			}),
		],
		(model, message) => MonitorUpdate.update(model, message, CONTEXT),
	)
}

export const init = (flags: Flags): Return => ({
	model: { state: flags.state, form: filledForm(), monitor: openedMonitor() },
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotFormMessage: ({ message: child }) => {
			const next = FormUpdate.update(model.form, child, CONTEXT)
			return {
				model: { ...model, form: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotFormMessage({ message: inner }),
				),
			}
		},
		GotMonitorMessage: ({ message: child }) => {
			const next = MonitorUpdate.update(model.monitor, child, CONTEXT)
			return {
				model: { ...model, monitor: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotMonitorMessage({ message: inner }),
				),
			}
		},
	})

export const breadcrumbs = (model: Model) =>
	model.state === "form" ? [{ label: "Alerts" }, { label: "Uptime" }] : breadcrumbsOf()

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	model.state === "form"
		? h.submodel({
				slotId: "lab-heartbeat-form",
				model: model.form,
				view: formView,
				viewInputs: { context: CONTEXT },
				toParentMessage: (message: FormMessage.Message) => Message.GotFormMessage({ message }),
			})
		: h.submodel({
				slotId: "lab-heartbeat-monitor",
				model: model.monitor,
				view: monitorView,
				viewInputs: { context: CONTEXT },
				toParentMessage: (message: MonitorMessage.Message) => Message.GotMonitorMessage({ message }),
			})
