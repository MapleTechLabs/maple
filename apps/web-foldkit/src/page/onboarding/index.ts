import { Option, Schema } from "effect"
import { Command, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { Resources } from "../../platform/resources"
import { AppRoute } from "../../route"
import * as CliLogin from "./cli-login"
import * as CliLoginView from "./cli-login-view"
import { selfHostedWorkspace } from "./workspace"

/**
 * The onboarding and auth-handoff screens legacy renders without `DashboardLayout`: CLI login,
 * MCP consent, unsubscribe, quick start, plan selection, org selection and sign-up. Some are
 * public or org-less, so they cannot take a `PageContext`; the root holds the open one here.
 */

// MODEL

export const Screen = Schema.Union([CliLogin.Model])
export type Screen = typeof Screen.Type

/** The open screen and the route key it was built for (legacy remounts on a new key). */
export const Model = Schema.Struct({ key: Schema.String, screen: Screen })
export type Model = typeof Model.Type

/** What the root knows about the session, read by every screen. */
export interface Inputs {
	readonly session: "SignedOut" | "SignedIn"
	readonly maybeOrgId: Option.Option<string>
}

// MESSAGE

export const Message = defineMessageUnion({
	GotCliLoginMessage: { message: CliLogin.Message },
})
export type Message = typeof Message.Type

export interface Step {
	readonly model: Model
	readonly commands: ReadonlyArray<Command.Command<Message, never, Resources>>
}

const step = <ScreenModel extends Screen, ScreenMessage>(
	key: string,
	result: {
		readonly model: ScreenModel
		readonly commands?: ReadonlyArray<Command.Command<ScreenMessage, never, Resources>>
	},
	wrap: (message: ScreenMessage) => Message,
): Step => ({
	model: { key, screen: result.model },
	commands: Command.mapMessages(result.commands ?? [], wrap),
})

const toCliLogin = (message: CliLogin.Message) => Message.GotCliLoginMessage({ message })

// ROUTES

/** The screen's key for a route it renders in this session, or `None` (a redirect is due). */
export const keyOf = (route: AppRoute, inputs: Inputs): Option.Option<string> => {
	const hasOrg = inputs.session === "SignedIn" && Option.isSome(inputs.maybeOrgId)
	return AppRoute.matchOrElse<Option.Option<string>>(
		route,
		{ CliLogin: () => (hasOrg ? Option.some("CliLogin") : Option.none()) },
		() => Option.none(),
	)
}

export const init = (route: AppRoute, key: string): Option.Option<Step> =>
	AppRoute.matchOrElse<Option.Option<Step>>(
		route,
		{ CliLogin: ({ search }) => Option.some(step(key, CliLogin.init(search.user_code), toCliLogin)) },
		() => Option.none(),
	)

// UPDATE

export const update = (model: Model, message: Message): Step =>
	Message.match<Step>(message, {
		GotCliLoginMessage: ({ message: child }) =>
			model.screen._tag === "CliLogin"
				? step(model.key, CliLogin.update(model.screen, child), toCliLogin)
				: { model, commands: [] },
	})

// VIEW

const cliLoginView = Submodel.defineView<CliLogin.Model, CliLogin.Message, Inputs>((model, inputs, h) =>
	CliLoginView.view(h, model, (wh) => selfHostedWorkspace(wh, inputs.maybeOrgId)),
)

const screenView = (screen: Screen, inputs: Inputs, h: HtmlBuilder<Message>): Html => {
	switch (screen._tag) {
		case "CliLogin":
			return h.submodel({
				slotId: "onboarding:CliLogin",
				model: screen,
				view: cliLoginView,
				viewInputs: inputs,
				toParentMessage: toCliLogin,
			})
	}
}

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) =>
	screenView(model.screen, inputs, h),
)
