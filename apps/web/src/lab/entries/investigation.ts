import { OrgId } from "@maple/domain"
import { Effect, Option, Schema, Array as Arr } from "effect"
import type { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PageContext } from "../../page/contract"
import type { Resources } from "../../platform/resources"
import { AppRoute } from "../../route"
import { Message } from "../../page/investigations/detail/message"
import { Model } from "../../page/investigations/detail/model"
import { init as pageInit, update as pageUpdate } from "../../page/investigations/detail/update"
import { view as pageView } from "../../page/investigations/detail/view"
import { VERDICT_LAB_CASES } from "../verdict-fixture"
import { defineShellLab } from "../shell-lab"

// `/lab/investigation`: the investigation page over the diagnosed fixture, without the live shape.
// API reads are dropped and answered here; the org has one connected repository.

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const diagnosed = Option.getOrThrow(Arr.findFirst(VERDICT_LAB_CASES, (entry) => entry.key === "diagnosed"))

const isLocalCommand = (command: { readonly name: string }): boolean =>
	!/^(Fetch|Resolve|Restart|LoadInvestigation)/.test(command.name)

type Step = Readonly<{ model: Model; commands: ReadonlyArray<Command.Command<Message, never, Resources>> }>

const send = (step: Step, message: Message): Step => {
	const next = pageUpdate(step.model, message, context)
	return {
		model: next.model,
		commands: [...step.commands, ...Arr.filter(next.commands ?? [], isLocalCommand)],
	}
}

/** `?action=<n>` opens that proposed action's sheet, so the handoff inside it can be linked to. */
const Flags = Schema.Struct({ action: Schema.NullOr(Schema.Number) })

const init = (flags: typeof Flags.Type) => {
	const id = diagnosed.investigation.id
	const search = flags.action === null ? {} : { action: flags.action }
	const entered = pageInit(AppRoute.Investigation({ id, search }), context)
	const start: Step = { model: entered.model, commands: Arr.filter(entered.commands ?? [], isLocalCommand) }
	return Arr.reduce(
		[
			Message.SyncedInvestigation({
				orgId: context.orgId,
				id,
				attempt: 0,
				sync: { _tag: "Ready", investigation: diagnosed.investigation },
			}),
			Message.CompletedFetchHandoffRepo({ repo: "acme/checkout" }),
		],
		start,
		send,
	)
}

const update = (model: Model, message: Message) => {
	const next = pageUpdate(model, message, context)
	return { model: next.model, commands: Arr.filter(next.commands ?? [], isLocalCommand) }
}

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "investigation-lab",
		model,
		view: pageView,
		viewInputs: { context },
		toParentMessage: (message: Message) => message,
	})

export const lab = defineShellLab("Investigation", {
	Model,
	Message,
	Flags,
	flags: Effect.sync(() => {
		const raw = new URLSearchParams(window.location.search).get("action")
		const action = raw === null || raw === "" ? Number.NaN : Number(raw)
		return { action: Number.isInteger(action) && action >= 0 ? action : null }
	}),
	init,
	update,
	view,
	currentPath: "/investigations",
	breadcrumbs: [{ label: "Investigations" }, { label: "Retry budget exhausted" }],
})
