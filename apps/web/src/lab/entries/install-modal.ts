import { Effect, Option, Result, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	init as modalInit,
	InstallTab,
	Message,
	Model,
	update as modalUpdate,
} from "../../page/infra/kit/install-modal"
import { view as modalView } from "../../page/infra/kit/install-modal-view"
import { defineLabWithFlags } from "../define"
import { keepLocal } from "../local-commands"

// `/lab/install-modal`: the collector install dialog, open on a fixture ingest key (`?tab=`).

const Flags = Schema.Struct({ tab: InstallTab })
type Flags = typeof Flags.Type

const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	tab: Option.getOrElse(
		Schema.decodeUnknownOption(InstallTab)(new URLSearchParams(window.location.search).get("tab")),
		(): InstallTab => "kubernetes",
	),
}))

const update = (model: Model, message: Message) => {
	const next = modalUpdate(model, message)
	return { model: next.model, commands: keepLocal(next.commands) }
}

const init = (flags: Flags) => {
	const keyed = modalUpdate(
		modalInit("lab-install", flags.tab),
		Message.CompletedFetchIngestKey({ result: Result.succeed("maple_sk_lab7Qm2c9VxR4tLw8Kp3nZ5") }),
	).model
	const opened = modalUpdate(keyed, Message.ClickedOpen())
	return { model: opened.model, commands: keepLocal(opened.commands) }
}

const view = (model: Model, h: HtmlBuilder<Message>): Html => modalView(model, h)

export const lab = defineLabWithFlags("Install a collector", {
	Model,
	Flags,
	flags,
	init,
	update,
	view,
	devTools: { Message },
})
