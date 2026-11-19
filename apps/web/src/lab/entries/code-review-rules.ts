import { PrReviewRepositoryConfig } from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as RulesForm from "../../page/code-review/rules-form/form"
import { view as rulesFormView } from "../../page/code-review/rules-form/view"
import { defineLabWithFlags } from "../define"

// `/lab/code-review-rules`: the organization's default review rules as two roles see them.
// `?as=engineer` may edit the rules but not turn automatic approval on; `?as=admin` may do both.
// `&approval=on` starts with approval saved on, which an engineer may turn off.
// `&repo=private` or `&repo=public` shows one repository's rules over these defaults instead; a
// public repository's Maple tools stay off.
// TODO(lab-save): Save changes nothing; the fixture rules exist nowhere to write to.

const Viewer = Schema.Literals(["admin", "engineer"])
type Viewer = typeof Viewer.Type

const Repo = Schema.Literals(["private", "public"])
type Repo = typeof Repo.Type

const Flags = Schema.Struct({ viewer: Viewer, approvalOn: Schema.Boolean, repo: Schema.NullOr(Repo) })
type Flags = typeof Flags.Type

const Model = Schema.Struct({ viewer: Viewer, repo: Schema.NullOr(Repo), form: RulesForm.Model })
type Model = typeof Model.Type

const Message = defineMessageUnion({ GotFormMessage: { message: RulesForm.Message } })
type Message = typeof Message.Type

const rules = (approvalOn: boolean) =>
	new PrReviewRepositoryConfig({
		instructions: "Flag any query that does not filter by organization.",
		ignorePaths: ["docs/", "*.snap"],
		autoApprove: approvalOn,
	})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("mx-auto max-w-3xl p-8")],
		[
			h.submodel({
				slotId: "lab-code-review-rules",
				model: model.form,
				view: rulesFormView,
				viewInputs: {
					canEdit: true,
					canAutoApprove: model.viewer === "admin",
					isPublic: model.repo === "public",
				},
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
		approvalOn: new URLSearchParams(window.location.search).get("approval") === "on",
		repo: Option.getOrNull(
			Schema.decodeUnknownOption(Repo)(new URLSearchParams(window.location.search).get("repo")),
		),
	})),
	init: (flags: Flags) => ({
		model: {
			viewer: flags.viewer,
			repo: flags.repo,
			form:
				flags.repo === null
					? RulesForm.init("lab-rules", "organization", rules(flags.approvalOn), null)
					: RulesForm.init(
							"lab-rules",
							"repository",
							new PrReviewRepositoryConfig({}),
							rules(flags.approvalOn),
						),
		},
	}),
	update: (model, message) =>
		Message.match(message, {
			GotFormMessage: ({ message: inner }) => {
				const next = RulesForm.update(model.form, inner).model
				// Nothing is written here, so a save settles at once, as the page settles it on success.
				return {
					model: {
						...model,
						form:
							inner._tag === "ClickedSave" ? RulesForm.completeSave(next, Option.none()) : next,
					},
				}
			},
		}),
	view,
})
