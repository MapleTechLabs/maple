import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { EscalationChainId } from "@maple/domain/http"
import { EscalationChainPublicId } from "@maple/domain/http/v2"
import { Effect, Option, Result, Schema, Array as Arr } from "effect"
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
	chainDestinationUuid,
	chainUuid,
	populatedChains,
} from "../page/alerts/shared/escalation-test-fixtures"
import { ORG, ruleId, ruleRow } from "../page/alerts/shared/test-rows"
import type { PageContext } from "../page/contract"
import type { Resources } from "../platform/resources"
import { keepLocal } from "./local-commands"

// `/lab/escalation-editor`: the escalation chain editor page over fixtures. `?state=` picks one.

export const LabState = Schema.Literals(["new", "populated", "inserted", "invalid", "delete"])
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
	ruleRow(2, { name: "Checkout p95 latency" }),
	ruleRow(3, { name: "Payments webhook failures" }),
]
const CHAINS = populatedChains([ruleId(1), ruleId(2), ruleId(3)])
const M = ChainMessage.Message

const NO_COMMANDS: PageCommands = []

const run = (model: ChainModel.Model, messages: ReadonlyArray<ChainMessage.Message>) =>
	Arr.reduce(messages, { model, commands: NO_COMMANDS }, (current, message) => {
		const next = chainUpdate(current.model, message, CONTEXT)
		return { model: next.model, commands: [...current.commands, ...keepLocal(next.commands)] }
	})

const pageFor = (state: LabState) => {
	const isNew = state === "new" || state === "invalid"
	const chainId = Schema.encodeSync(EscalationChainPublicId)(
		Schema.decodeSync(EscalationChainId)(chainUuid(1)),
	)
	const entered = chainInit(
		isNew
			? { _tag: "AlertsEscalationChainNew", search: {} }
			: { _tag: "AlertsEscalationChain", chainId, search: {} },
		CONTEXT,
	).model
	const base = [
		M.CompletedFetchSession({ orgId: ORG, grants: Policy.grantsOf(["org:engineer"]) }),
		M.CompletedFetchMembers({ result: Result.succeed([]) }),
		M.CompletedFetchSchedules({ result: Result.succeed([]) }),
		M.UpdatedDestinations({ orgId: ORG, rows: chainDestinations }),
		M.UpdatedRules({ orgId: ORG, rows: RULES }),
	]
	const loaded = isNew
		? []
		: Arr.map(Arr.take(CHAINS, 1), (chain) =>
				M.CompletedFetchExisting({ key: entered.existing.key ?? "", result: Result.succeed(chain) }),
			)
	const extra: ReadonlyArray<ChainMessage.Message> =
		state === "invalid"
			? [M.ChangedWait({ key: "s0", value: "2000" }), M.ClickedSave()]
			: state === "inserted"
				? [
						M.ClickedInsertStep({ index: 1 }),
						M.GotMenuMessage({
							kind: "targets",
							key: "s3",
							message: {
								_tag: "ClickedItem",
								index: 0,
								item: { kind: "Item", value: `destination:${chainDestinationUuid(3)}` },
							},
						}),
					]
				: state === "delete"
					? [M.ClickedDelete()]
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
