import { OrgId } from "@maple/domain"
import { Effect, Option, Schema } from "effect"
import { AsyncData, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { PageContext } from "../page/contract"
import * as PageMessage from "../page/settings/ai-credits/message"
import * as PageModel from "../page/settings/ai-credits/model"
import { update as pageUpdate } from "../page/settings/ai-credits/update"
import { view as pageView } from "../page/settings/ai-credits/view"
import type { Resources } from "../platform/resources"
import { aiCreditUsageFixture } from "./ai-credits-fixture"

// `/lab/ai-credits`: the AI credits page over fixtures. `?state=` picks one: code-review (the
// default), chat (spend but no reviews), empty, loading, error.

export const LabState = Schema.Literals(["code-review", "chat", "empty", "loading", "error"])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "code-review",
	),
}))

export const Model = Schema.Struct({ state: LabState, page: PageModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotPageMessage: { message: PageMessage.Message } })
export type Message = typeof Message.Type

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

type Return = Update.Return<Model, Message, Resources>

const usageOf = (state: LabState): PageModel.Model["usage"] => {
	switch (state) {
		case "loading":
			return AsyncData.Loading()
		case "error":
			return AsyncData.Failure({
				error: toLoadFailure(new Error("The billing service didn't answer.")),
			})
		case "empty":
			return AsyncData.Success({ data: aiCreditUsageFixture("empty") })
		case "chat":
			return AsyncData.Success({ data: aiCreditUsageFixture("chat") })
		case "code-review":
			return AsyncData.Success({ data: aiCreditUsageFixture("code-review") })
	}
}

export const init = (flags: Flags): Return => ({
	model: { state: flags.state, page: { usage: usageOf(flags.state) } },
})

/** No reads: a retry answers with the fixture (the loaded one, after the error state). */
export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPageMessage: ({ message: child }) =>
			child._tag === "ClickedRetry"
				? {
						model: {
							...model,
							page: { usage: usageOf(model.state === "error" ? "code-review" : model.state) },
						},
					}
				: { model: { ...model, page: pageUpdate(model.page, child, context).model } },
	})

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "lab-ai-credits",
		model: model.page,
		view: pageView,
		viewInputs: { context },
		toParentMessage: (message: PageMessage.Message) => Message.GotPageMessage({ message }),
	})
