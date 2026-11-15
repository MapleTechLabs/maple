import { Array as Arr, Effect, Option, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Field from "@maple/views/ui/field"
import * as DomainsModel from "../page/settings/domains/model"
import * as DomainsUpdate from "../page/settings/domains/update"
import * as DomainsView from "../page/settings/domains/view"
import type { Resources } from "../platform/resources"
import { hstack } from "@maple/views/ui/stack"
import { keepLocal } from "./local-commands"

// `/lab/domains`: the settings Domains tab over fixtures, seen by an admin. `?state=` picks a start:
// the list, no domains yet, or the verify dialog on its address or code step.

export const LabState = Schema.Literals(["list", "empty", "verify-email", "verify-code", "add"])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "list",
	),
}))

export const Model = Schema.Struct({ domains: DomainsModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotDomainsMessage: { message: DomainsModel.Message } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const ROWS: ReadonlyArray<DomainsModel.DomainRow> = [
	{
		id: "dmn_acme",
		name: "acme.com",
		isVerified: true,
		enrollment: "automatic_invitation",
		affiliationEmail: "ada@acme.com",
	},
	{
		id: "dmn_acme_eu",
		name: "acme.eu",
		isVerified: true,
		enrollment: "manual_invitation",
		affiliationEmail: "ada@acme.eu",
	},
	{
		id: "dmn_acme_labs",
		name: "acmelabs.io",
		isVerified: false,
		enrollment: "manual_invitation",
		affiliationEmail: null,
	},
]

const step = (model: DomainsModel.Model, message: DomainsModel.Message): DomainsModel.Model =>
	DomainsUpdate.update(model, message).model

export const init = (flags: Flags): Return => {
	const loaded = Arr.reduce(
		[
			DomainsModel.Message.CompletedFetchOrganization({ hasOrganization: true }),
			DomainsModel.Message.CompletedFetchDomains({
				result: Result.succeed(flags.state === "empty" ? [] : ROWS),
			}),
		],
		DomainsUpdate.init().model,
		step,
	)
	const opening =
		flags.state === "verify-email" || flags.state === "verify-code"
			? DomainsModel.Message.ClickedVerify({ id: "dmn_acme_labs" })
			: flags.state === "add"
				? DomainsModel.Message.ClickedAdd()
				: null
	if (opening === null) return { model: { domains: loaded } }
	// The dialog's open commands run, so it mounts as it would from a click.
	const opened = DomainsUpdate.update(loaded, opening)
	const model =
		flags.state === "verify-code"
			? {
					...opened.model,
					verifying: {
						id: "dmn_acme_labs",
						name: "acmelabs.io",
						step: "code" as const,
						email: "ada@acmelabs.io",
					},
				}
			: flags.state === "verify-email"
				? { ...opened.model, emailField: Field.init("ada@acmelabs") }
				: { ...opened.model, domainField: Field.init("acmelabs.io") }
	return {
		model: { domains: model },
		commands: Command.mapMessages(keepLocal(opened.commands), (message) =>
			Message.GotDomainsMessage({ message }),
		),
	}
}

/** Kit commands run; every Clerk read and write is dropped. */
export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDomainsMessage: ({ message: child }) => {
			const next = DomainsUpdate.update(model.domains, child)
			return {
				model: { domains: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (message) =>
					Message.GotDomainsMessage({ message }),
				),
			}
		},
	})

export const breadcrumbs = [{ label: "Lab", href: "/lab" }, { label: "Verified domains" }] as const

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("mx-auto w-full max-w-4xl space-y-4 p-6")],
		[
			hstack(h, { justify: "end" }, [
				h.submodel({
					slotId: "lab-domains-actions",
					model: model.domains,
					view: DomainsView.headerActions,
					viewInputs: {},
					toParentMessage: (message: DomainsModel.Message) =>
						Message.GotDomainsMessage({ message }),
				}),
			]),
			h.submodel({
				slotId: "lab-domains",
				model: model.domains,
				view: DomainsView.view,
				viewInputs: {},
				toParentMessage: (message: DomainsModel.Message) => Message.GotDomainsMessage({ message }),
			}),
		],
	)
