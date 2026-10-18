import { Option, Schema } from "effect"
import { Command, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { Resources } from "../../platform/resources"
import { AppRoute } from "../../route"
import * as CliLogin from "./cli-login"
import * as CliLoginView from "./cli-login-view"
import * as McpAuthorize from "./mcp-authorize"
import * as McpAuthorizeView from "./mcp-authorize-view"
import * as Unsubscribe from "./unsubscribe"
import { selfHostedWorkspace } from "./workspace"

/**
 * The onboarding and auth-handoff screens legacy renders without `DashboardLayout`: CLI login,
 * MCP consent, unsubscribe, quick start, plan selection, org selection and sign-up. Some are
 * public or org-less, so they cannot take a `PageContext`; the root holds the open one here.
 */

// MODEL

export const Screen = Schema.Union([CliLogin.Model, McpAuthorize.Model, Unsubscribe.Model])
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
	GotMcpAuthorizeMessage: { message: McpAuthorize.Message },
	GotUnsubscribeMessage: { message: Unsubscribe.Message },
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
const toMcpAuthorize = (message: McpAuthorize.Message) => Message.GotMcpAuthorizeMessage({ message })
const toUnsubscribe = (message: Unsubscribe.Message) => Message.GotUnsubscribeMessage({ message })

// ROUTES

/** The screen's key for a route it renders in this session, or `None` (a redirect is due). */
export const keyOf = (route: AppRoute, inputs: Inputs): Option.Option<string> => {
	const withOrg = (key: string) =>
		inputs.session === "SignedIn" && Option.isSome(inputs.maybeOrgId) ? Option.some(key) : Option.none()
	return AppRoute.matchOrElse<Option.Option<string>>(
		route,
		{
			CliLogin: () => withOrg("CliLogin"),
			McpAuthorize: () => withOrg("McpAuthorize"),
			Unsubscribe: ({ search }) => Option.some(Unsubscribe.keyOf(search.token)),
		},
		() => Option.none(),
	)
}

export const init = (route: AppRoute, key: string): Option.Option<Step> =>
	AppRoute.matchOrElse<Option.Option<Step>>(
		route,
		{
			CliLogin: ({ search }) => Option.some(step(key, CliLogin.init(search.user_code), toCliLogin)),
			McpAuthorize: ({ search }) =>
				Option.some(step(key, McpAuthorize.init(search.request_id), toMcpAuthorize)),
			Unsubscribe: ({ search }) =>
				Option.some(step(key, { model: Unsubscribe.init(search.token) }, toUnsubscribe)),
		},
		() => Option.none(),
	)

// UPDATE

const unchanged = (model: Model): Step => ({ model, commands: [] })

export const update = (model: Model, message: Message): Step => {
	const { key, screen } = model
	return Message.match<Step>(message, {
		GotCliLoginMessage: ({ message: child }) =>
			screen._tag === "CliLogin" ? step(key, CliLogin.update(screen, child), toCliLogin) : unchanged(model),
		GotMcpAuthorizeMessage: ({ message: child }) =>
			screen._tag === "McpAuthorize"
				? step(key, McpAuthorize.update(screen, child), toMcpAuthorize)
				: unchanged(model),
		GotUnsubscribeMessage: ({ message: child }) =>
			screen._tag === "Unsubscribe"
				? step(key, Unsubscribe.update(screen, child), toUnsubscribe)
				: unchanged(model),
	})
}

// VIEW

const cliLoginView = Submodel.defineView<CliLogin.Model, CliLogin.Message, Inputs>((model, inputs, h) =>
	CliLoginView.view(h, model, selfHostedWorkspace(h, inputs.maybeOrgId)),
)

const mcpAuthorizeView = Submodel.defineView<McpAuthorize.Model, McpAuthorize.Message, Inputs>(
	(model, inputs, h) => McpAuthorizeView.view(h, model, selfHostedWorkspace(h, inputs.maybeOrgId)),
)

const unsubscribeView = Submodel.defineView<Unsubscribe.Model, Unsubscribe.Message>((model, h) =>
	Unsubscribe.view(h, model),
)

const screenView = (screen: Screen, inputs: Inputs, h: HtmlBuilder<Message>): Html => {
	const slotId = `onboarding:${screen._tag}`
	switch (screen._tag) {
		case "CliLogin":
			return h.submodel({ slotId, model: screen, view: cliLoginView, viewInputs: inputs, toParentMessage: toCliLogin })
		case "McpAuthorize":
			return h.submodel({
				slotId,
				model: screen,
				view: mcpAuthorizeView,
				viewInputs: inputs,
				toParentMessage: toMcpAuthorize,
			})
		case "Unsubscribe":
			return h.submodel({ slotId, model: screen, view: unsubscribeView, toParentMessage: toUnsubscribe })
	}
}

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) =>
	screenView(model.screen, inputs, h),
)
