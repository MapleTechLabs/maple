import type { Resources } from "./platform/resources"
import * as Popover from "@maple/web-foldkit/ui/popover"
import * as Toast from "@maple/web-foldkit/ui/toast"
import { Effect, Option, Schema } from "effect"
import { AsyncData, type Runtime } from "foldkit"
import type { Url } from "foldkit/url"
import { ApplyTheme, ProbeServer } from "./command"
import { LocalEnv, readLocalEnv, readRememberedRange, readSidebarOpen, readTheme, Theme } from "./env"
import type { Message } from "./message"
import type { Model } from "./model"
import { hashOf, locationOf, routeOf } from "./navigation"
import { CONNECT_POPOVER_ID } from "./shell/connect"
import { enterLocation } from "./update-page"
import { placeholder } from "./page/registry"

export { Message } from "./message"
export { Model } from "./model"
export { subscriptions } from "./subscription"
export { update } from "./update"
export { view } from "./view"

/** Read before the first render: where the server is, the remembered range and the sidebar. */
export const Flags = Schema.Struct({
	env: LocalEnv,
	rememberedRange: Schema.String,
	isSidebarOpen: Schema.Boolean,
	theme: Theme,
})
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.all({
	env: readLocalEnv,
	rememberedRange: readRememberedRange,
	isSidebarOpen: readSidebarOpen,
	theme: readTheme,
})

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags, Resources> = (flags, url: Url) => {
	const location = locationOf(url)
	const model: Model = {
		location,
		route: routeOf(location),
		visited: [hashOf(url)],
		isReplacing: false,
		env: flags.env,
		rememberedRange: flags.rememberedRange,
		theme: flags.theme,
		isSidebarOpen: flags.isSidebarOpen,
		isSidebarOpenMobile: false,
		maybeServer: Option.none(),
		probe: { isInFlight: true, version: 0 },
		hasIngested: false,
		connect: Popover.init(CONNECT_POPOVER_ID, { side: "right", align: "end" }),
		presence: AsyncData.Idle(),
		copies: {},
		toasts: Toast.init("toasts"),
		page: placeholder(""),
	}
	const entered = enterLocation(model, null)
	return {
		model: entered.model,
		commands: [ApplyTheme({ theme: flags.theme }), ProbeServer({ apiBase: flags.env.apiBase }), ...(entered.commands ?? [])],
	}
}
