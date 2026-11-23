import * as Policy from "@maple/domain/policy"
import { GroupingConfigDocument, IsoDateTimeString } from "@maple/domain/http"
import { OrgGroupingRule } from "@maple/domain/tinybird/grouping-rules"
import { Array as Arr, Effect, Option, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Rules from "../page/settings/automation/grouping-rules"
import * as RulesView from "../page/settings/automation/grouping-rules-view"
import type { Resources } from "../platform/resources"
import { keepLocal } from "./local-commands"

// `/lab/grouping-rules`: Settings > Automation's error grouping rules editor over fixtures, as an
// admin, or as a member who reads the rules and cannot change them. `?state=` picks one.

export const LabState = Schema.Literals(["populated", "empty", "loading", "error", "invalid", "member"])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "populated",
	),
}))

export const Model = Schema.Struct({
	state: LabState,
	grants: Schema.Array(Policy.PermissionName),
	rules: Rules.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotRulesMessage: { message: Rules.Message } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const iso = Schema.decodeSync(IsoDateTimeString)

const RULES: ReadonlyArray<OrgGroupingRule> = [
	new OrgGroupingRule({
		id: "rule-1",
		kind: "merge",
		service: "subscriptions-api",
		exceptionType: "TypeError",
		message: "*reading 'plan*",
		title: "Plan lookups on renewal",
	}),
	new OrgGroupingRule({ id: "rule-2", kind: "library-frames", frame: "*node_modules/@acme/http/*" }),
	new OrgGroupingRule({
		id: "rule-3",
		kind: "app-frames",
		service: "checkout-web",
		frame: "*packages/checkout-sdk/src/*",
	}),
	new OrgGroupingRule({ id: "rule-4", kind: "merge", message: "*upstream request timed out*" }),
]

const document = (rules: ReadonlyArray<OrgGroupingRule>) =>
	new GroupingConfigDocument({ rules, updatedAt: iso("2026-11-20T09:30:00.000Z") })

const grantsOf = (state: LabState) => Policy.grantsOf([state === "member" ? "org:member" : "org:admin"])

const step = (model: Rules.Model, message: Rules.Message, grants: ReadonlyArray<Policy.Permission>) =>
	Rules.update(model, message, grants).model

export const init = (flags: Flags): Return => {
	const grants = grantsOf(flags.state)
	const entered = Rules.init().model
	const answer =
		flags.state === "loading"
			? null
			: flags.state === "error"
				? Result.fail(toLoadFailure("Maple's backend is unavailable."))
				: Result.succeed(document(flags.state === "empty" ? [] : RULES))
	const loaded =
		answer === null
			? entered
			: step(entered, Rules.Message.CompletedFetchRules({ result: answer }), grants)
	// An invalid save: a frame rule lost its pattern and a merge rule matches nothing, as the server says.
	const rules =
		flags.state !== "invalid"
			? loaded
			: Arr.reduce(
					[
						Rules.Message.ChangedRuleField({ id: "rule-2", field: "frame", value: "" }),
						Rules.Message.ClickedAddRule(),
						Rules.Message.ClickedSaveRules(),
						Rules.Message.CompletedSaveRules({
							result: Result.fail({
								message: "These grouping rules cannot be saved.",
								problems: Rules.problemsOf(
									[
										"rule-2: a frame rule needs a frame pattern",
										"rule-5: a merge rule needs an exception type, message or frame pattern",
									],
									["rule-1", "rule-2", "rule-3", "rule-4", "rule-5"],
								),
							}),
						}),
					],
					loaded,
					(model, message) => step(model, message, grants),
				)
	return { model: { state: flags.state, grants, rules } }
}

/** A save is answered at once with the rules it sent, as the API would store them. */
export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotRulesMessage: ({ message: child }) => {
			const next = Rules.update(model.rules, child, model.grants)
			const saved =
				child._tag === "ClickedSaveRules" && next.model.isSaving && next.model.draft !== null
					? Rules.update(
							next.model,
							Rules.Message.CompletedSaveRules({
								result: Result.succeed(document(Rules.configOf(next.model.draft).rules)),
							}),
							model.grants,
						).model
					: next.model
			return {
				model: { ...model, rules: saved },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotRulesMessage({ message: inner }),
				),
			}
		},
	})

export const breadcrumbs = [{ label: "Lab", href: "/lab" }, { label: "Error grouping rules" }] as const

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("mx-auto w-full max-w-3xl p-6")],
		[
			h.submodel({
				slotId: "lab-grouping-rules",
				model: model.rules,
				view: RulesView.view,
				viewInputs: { canManage: Rules.canManageGrouping(model.grants), isKnownMember: true },
				toParentMessage: (message: Rules.Message) => Message.GotRulesMessage({ message }),
			}),
		],
	)
