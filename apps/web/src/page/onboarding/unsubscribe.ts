import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import { MapleApiClient } from "../../platform/api-clients"
import type { Resources } from "../../platform/resources"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { authDescription, authLayout, authTitle } from "./auth-layout"

// `/unsubscribe`: the digest email's footer link. Public: the signed token is the credential, and
// unsubscribing waits for a click (mail scanners prefetch).

// MODEL

export const State = defineTaggedUnion({
	Idle: {},
	Pending: {},
	Done: {},
	Failed: { message: Schema.String },
})
export type State = typeof State.Type

export const Model = Schema.TaggedStruct("Unsubscribe", { token: Schema.NullOr(Schema.String), state: State })
export type Model = typeof Model.Type

export const init = (token: string | undefined): Model => ({
	_tag: "Unsubscribe",
	token: token === undefined || token === "" ? null : token,
	state: State.Idle(),
})

/** Keyed by token, so a same-route visit to another email's link starts fresh. */
export const keyOf = (token: string | undefined): string => `Unsubscribe:${token ?? ""}`

const labelForToken = (token: string): string => {
	const kind = token.split(".")[0]
	if (kind === "digest") return "the weekly digest"
	if (kind === "web-analytics") return "the weekly web analytics email"
	return "these emails"
}

// MESSAGE

export const Message = defineMessageUnion({
	ClickedUnsubscribe: {},
	SucceededUnsubscribe: {},
	FailedUnsubscribe: { isInvalidToken: Schema.Boolean },
})
export type Message = typeof Message.Type

// COMMAND

/** `POST /api/email/unsubscribe?token=`. */
export const Unsubscribe = Command.define("Unsubscribe", {
	args: { token: Schema.String },
	messages: [Message.SucceededUnsubscribe, Message.FailedUnsubscribe],
	execute: ({ token }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiClient
			yield* client.emailPublic.unsubscribe({ query: { token } })
			return Message.SucceededUnsubscribe()
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(
					Message.FailedUnsubscribe({
						isInvalidToken: error._tag === "@maple/http/errors/DigestUnsubscribeTokenInvalidError",
					}),
				),
			),
		),
})

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message, Resources> =>
	Message.match<Update.Return<Model, Message, Resources>>(message, {
		ClickedUnsubscribe: () =>
			model.token === null || model.state._tag === "Pending"
				? { model }
				: {
						model: modifyFields(model, { state: () => State.Pending() }),
						commands: [Unsubscribe({ token: model.token })],
					},
		SucceededUnsubscribe: () => ({ model: modifyFields(model, { state: () => State.Done() }) }),
		FailedUnsubscribe: ({ isInvalidToken }) => ({
			model: modifyFields(model, {
				state: () =>
					State.Failed({
						message: isInvalidToken
							? "This unsubscribe link is invalid. Use the link from the email itself."
							: "Something went wrong. Please try again.",
					}),
			}),
		}),
	})

// VIEW

type H = HtmlBuilder<Message>

const confirm = (h: H, token: string, state: State): ReadonlyArray<Html> => [
	authTitle(h, ["Unsubscribe"]),
	authDescription(h, ["Stop receiving ", labelForToken(token), " from Maple?"]),
	...(state._tag === "Failed" ? [h.p([h.Class("mt-3 text-sm text-destructive-foreground")], [state.message])] : []),
	h.div(
		[h.Class("mt-4")],
		[
			button(
				h,
				{ isLoading: state._tag === "Pending", attributes: [h.OnClick(Message.ClickedUnsubscribe())] },
				["Unsubscribe"],
			),
		],
	),
]

const done = (h: H, token: string): ReadonlyArray<Html> => [
	authTitle(h, ["You're unsubscribed"]),
	authDescription(h, [
		"You won't receive ",
		labelForToken(token),
		" anymore. You can turn it back on any time in your notification settings.",
	]),
	h.div(
		[h.Class("mt-4")],
		[
			linkButton(
				h,
				{ variant: "outline", href: hrefOf(AppRoute.Account({ search: { tab: "email-preferences" } })) },
				["Notification settings"],
			),
		],
	),
]

export const view = (h: H, model: Model): Html =>
	authLayout(
		h,
		"max-w-md",
		model.token === null
			? [
					authTitle(h, ["Invalid unsubscribe link"]),
					authDescription(h, ["This link is incomplete. Use the unsubscribe link from the email itself."]),
				]
			: model.state._tag === "Done"
				? done(h, model.token)
				: confirm(h, model.token, model.state),
	)
