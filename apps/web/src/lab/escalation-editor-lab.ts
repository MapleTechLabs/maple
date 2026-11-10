import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { OnCallScheduleId } from "@maple/domain/http"
import { EscalationChainPublicId } from "@maple/domain/http/v2"
import { Effect, Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as ChainMessage from "../page/alerts/escalation-chain/message"
import * as ChainModel from "../page/alerts/escalation-chain/model"
import { init as chainInit, update as chainUpdate } from "../page/alerts/escalation-chain/update"
import { chainTitle, view as chainView } from "../page/alerts/escalation-chain/view"
import { routingTabHref } from "../page/alerts/shared/escalation-chains"
import {
	chainDestinations,
	chainOf,
	chainScheduleUuid,
	populatedChains,
} from "../page/alerts/shared/escalation-test-fixtures"
import { memberId, oncallMembers, populatedSchedules } from "../page/alerts/shared/oncall-test-fixtures"
import { ORG, ruleId, ruleRow } from "../page/alerts/shared/test-rows"
import type { PageContext } from "../page/contract"
import type { Resources } from "../platform/resources"
import { keepLocal } from "./local-commands"

// `/lab/escalation-editor`: the escalation chain editor page over fixtures. `?state=` picks one.

export const LabState = Schema.Literals([
	"new",
	"populated",
	"inserted",
	"invalid",
	"delete",
	"leave",
	"readonly",
	"long",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "populated",
	),
}))

export const Model = Schema.Struct({ state: LabState, page: ChainModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotPageMessage: { message: ChainMessage.Message } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>
type PageCommands = ReadonlyArray<Command.Command<ChainMessage.Message, never, Resources>>

const CONTEXT: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const RULES = [
	ruleRow(1, { name: "Checkout error rate" }),
	ruleRow(2, { name: "Checkout p95 latency", enabled: false }),
	ruleRow(3, { name: "Payments webhook failures" }),
]
const M = ChainMessage.Message

/** The fixture destinations with the type their name says, so each draws its own mark. */
const TYPES: ReadonlyArray<readonly [prefix: string, type: string, chatConnector?: string]> = [
	["Slack", "chat", "slack"],
	["PagerDuty", "pagerduty"],
	["Email", "email"],
	["Discord", "discord"],
	["Microsoft Teams", "microsoft-teams"],
]
const DESTINATIONS = Arr.map(chainDestinations, (row) =>
	Option.match(
		Arr.findFirst(TYPES, ([prefix]) => Str.startsWith(prefix)(row.name)),
		{
			onNone: () => row,
			onSome: ([, type, chatConnector]) => ({
				...row,
				type,
				config_json: {
					summary: row.name,
					channelLabel: null,
					...(chatConnector === undefined ? undefined : { chatConnector }),
				},
			}),
		},
	),
)

/** One schedule, under the id the fixture chains page. */
const SCHEDULES = Arr.map(Arr.take(populatedSchedules(), 1), (schedule) => ({
	...schedule,
	id: Schema.decodeSync(OnCallScheduleId)(chainScheduleUuid(1)),
}))

/** The everyday chain, paging a schedule and a person beside its destinations. */
const EVERYDAY = chainOf({
	n: 1,
	name: "Checkout on-call",
	description: "Checkout team first, then the platform lead.",
	steps: [
		{ destinations: [1], schedules: [1], wait: 10 },
		{ destinations: [2], wait: 15 },
		{ destinations: [3], users: [memberId(0)], wait: 30 },
	],
	repeat: 2,
	ruleIds: [ruleId(1), ruleId(2)],
})
const LONG = populatedChains([])[2]

const NO_COMMANDS: PageCommands = []

const run = (model: ChainModel.Model, messages: ReadonlyArray<ChainMessage.Message>) =>
	Arr.reduce(messages, { model, commands: NO_COMMANDS }, (current, message) => {
		const next = chainUpdate(current.model, message, CONTEXT)
		return { model: next.model, commands: [...current.commands, ...keepLocal(next.commands)] }
	})

const pageFor = (state: LabState) => {
	const isNew = state === "new" || state === "invalid"
	const chain = state === "long" ? (LONG ?? EVERYDAY) : EVERYDAY
	const entered = chainInit(
		isNew
			? { _tag: "AlertsEscalationChainNew", search: {} }
			: {
					_tag: "AlertsEscalationChain",
					chainId: Schema.encodeSync(EscalationChainPublicId)(chain.id),
					search: {},
				},
		CONTEXT,
	).model
	const base = [
		M.CompletedFetchSession({
			orgId: ORG,
			grants: Policy.grantsOf([state === "readonly" ? "org:member" : "org:engineer"]),
		}),
		M.CompletedFetchMembers({ result: Result.succeed(oncallMembers) }),
		M.CompletedFetchSchedules({ result: Result.succeed(SCHEDULES) }),
		M.UpdatedDestinations({ orgId: ORG, rows: DESTINATIONS }),
		M.UpdatedRules({ orgId: ORG, rows: RULES }),
	]
	const loaded = isNew
		? []
		: [M.CompletedFetchExisting({ key: entered.existing.key ?? "", result: Result.succeed(chain) })]
	const extra: ReadonlyArray<ChainMessage.Message> =
		state === "invalid"
			? [M.ChangedWait({ key: "s0", value: "2000" }), M.ClickedSave()]
			: state === "inserted"
				? [M.ClickedInsertStep({ index: 1 })]
				: state === "delete"
					? [M.ClickedDelete()]
					: state === "leave"
						? [M.ChangedWait({ key: "s0", value: "20" }), M.ClickedCancel()]
						: []
	return run(entered, [...base, ...loaded, ...extra])
}

export const init = (flags: Flags): Return => {
	const page = pageFor(flags.state)
	return {
		model: { state: flags.state, page: page.model },
		commands: Command.mapMessages(page.commands, (message) => Message.GotPageMessage({ message })),
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPageMessage: ({ message: child }) => {
			const next = chainUpdate(model.page, child, CONTEXT)
			return {
				model: { ...model, page: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotPageMessage({ message: inner }),
				),
			}
		},
	})

export const breadcrumbs = (model: Model) => [
	{ label: "Alerts", href: "/alerts" },
	{ label: "Routing", href: routingTabHref() },
	{ label: chainTitle(model.page) },
]

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "lab-escalation-editor",
		model: model.page,
		view: chainView,
		viewInputs: { context: CONTEXT },
		toParentMessage: (message: ChainMessage.Message) => Message.GotPageMessage({ message }),
	})
