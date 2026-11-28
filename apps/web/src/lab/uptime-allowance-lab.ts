import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { Effect, Option, Schema, Array as Arr } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext } from "../page/contract"
import { destinationRow } from "../page/kit/alert-test-rows"
import type { MonitorAllowance } from "../page/kit/billing/uptime-allowance"
import * as FormMessage from "../page/alerts/uptime-form/message"
import * as FormModel from "../page/alerts/uptime-form/model"
import * as FormUpdate from "../page/alerts/uptime-form/update"
import { view as formView } from "../page/alerts/uptime-form/view"
import type { Resources } from "../platform/resources"

// `/lab/uptime-allowance`: the new-monitor form at each point of the plan's monitor allowance.
// `?state=` picks one: billed (a paid plan past 10), last (the 10th), trial (a trial at 10), free.

export const LabState = Schema.Literals(["billed", "last", "trial", "free"])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "billed",
	),
}))

export const Model = Schema.Struct({ form: FormModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotFormMessage: { message: FormMessage.Message },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const ORG = "org_lab_uptime_allowance"
const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)(ORG),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const ALLOWANCES = {
	billed: { included: 10, used: 12, isBilledPastIncluded: true },
	last: { included: 10, used: 9, isBilledPastIncluded: true },
	trial: { included: 10, used: 10, isBilledPastIncluded: false },
	free: { included: 10, used: 3, isBilledPastIncluded: true },
} satisfies Record<LabState, MonitorAllowance>

/** The page's reads and writes are dropped: the fixture is all the data there is. */
const keepLocal = <M>(commands: ReadonlyArray<Command.Command<M, never, Resources>> | undefined) =>
	Arr.filter(commands ?? [], (command) => !/^(Fetch|Save|Test|Read)/.test(command.name))

const filledForm = (state: LabState) => {
	const entered = FormUpdate.init({ _tag: "AlertsUptimeNew", search: {} }, CONTEXT).model
	return Arr.reduce(
		[
			FormMessage.Message.CompletedFetchSession({
				orgId: ORG,
				grants: Policy.grantsOf(["org:engineer"]),
			}),
			FormMessage.Message.CompletedFetchServices({ services: ["checkout", "search"] }),
			FormMessage.Message.UpdatedDestinations({ orgId: ORG, rows: [destinationRow()] }),
			FormMessage.Message.CompletedFetchAllowance({ orgId: ORG, allowance: ALLOWANCES[state] }),
			FormMessage.Message.ChangedText({ field: "url", value: "https://api.acme.dev/checkout/health" }),
		],
		entered,
		(model, message) => FormUpdate.update(model, message, CONTEXT).model,
	)
}

export const init = (flags: Flags): Return => ({ model: { form: filledForm(flags.state) } })

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotFormMessage: ({ message: child }) => {
			const next = FormUpdate.update(model.form, child, CONTEXT)
			return {
				model: { form: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotFormMessage({ message: inner }),
				),
			}
		},
	})

export const breadcrumbs = () => [{ label: "Alerts" }, { label: "Uptime" }]

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "lab-uptime-allowance-form",
		model: model.form,
		view: formView,
		viewInputs: { context: CONTEXT },
		toParentMessage: (message: FormMessage.Message) => Message.GotFormMessage({ message }),
	})
