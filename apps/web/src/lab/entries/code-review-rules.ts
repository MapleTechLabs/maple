import { PrReviewRepositoryConfig } from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as RulesForm from "../../page/code-review/rules-form/form"
import { view as rulesFormView } from "../../page/code-review/rules-form/view"
import { defineLabWithFlags } from "../define"

// `/lab/code-review-rules`: the organization's default review rules as two roles see them.
// `?as=engineer` may edit the rules but not turn automatic approval on; `?as=admin` may do both.
// TODO(lab-save): Save changes nothing; the fixture rules exist nowhere to write to.

const Viewer = Schema.Literals(["admin", "engineer"])
type Viewer = typeof Viewer.Type

const Flags = Schema.Struct({ viewer: Viewer })
type Flags = typeof Flags.Type

const Model = Schema.Struct({ viewer: Viewer, form: RulesForm.Model })
type Model = typeof Model.Type

const Message = defineMessageUnion({ GotFormMessage: { message: RulesForm.Message } })
type Message = typeof Message.Type

const RULES = new PrReviewRepositoryConfig({
	instructions: "Flag any query that does not filter by organization.",
	ignorePaths: ["docs/", "*.snap"],
	autoApprove: true,
})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("mx-auto max-w-3xl p-8")],
		[
			h.submodel({
				slotId: "lab-code-review-rules",
				model: model.form,
				view: rulesFormView,
				viewInputs: { canEdit: true, canAutoApprove: model.viewer === "admin" },
				toParentMessage: (message: RulesForm.Message) => Message.GotFormMessage({ message }),
			}),
		],
	)

export const lab = defineLabWithFlags("Code review rules", {
	Model,
	Flags,
	flags: Effect.sync(() => ({
		viewer: Option.getOrElse(
			Schema.decodeUnknownOption(Viewer)(new URLSearchParams(window.location.search).get("as")),
			(): Viewer => "engineer",
		),
	})),
	init: (flags: Flags) => ({
		model: { viewer: flags.viewer, form: RulesForm.init("lab-rules", "organization", RULES, null) },
	}),
	update: (model, message) =>
		Message.match(message, {
			GotFormMessage: ({ message: inner }) => ({
				model: { ...model, form: RulesForm.update(model.form, inner).model },
			}),
		}),
	view,
})
