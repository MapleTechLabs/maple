import type { Resources } from "./platform/resources"
import * as Popover from "@maple/web/ui/popover"
import { INSTALL_METHODS } from "./lib/links"
import * as Tabs from "@maple/web/ui/tabs"
import * as Toast from "@maple/web/ui/toast"
import { Effect, Option, Schema } from "effect"
import { AsyncData, type Runtime } from "foldkit"
import type { Url } from "foldkit/url"
import { ApplyTheme, ProbeServer } from "./command"
import { LocalEnv, readIsMobile, readLocalEnv, readRememberedRange, readSidebarOpen, readTheme, readTimeFormat, Theme } from "./env"
import { TimeFormat } from "./page/kit/local-time"
import type { Message } from "./message"
import { initFilterDrawer, type Model } from "./model"
import { hashOf, locationOf, routeOf } from "./navigation"
import { CONNECT_POPOVER_ID } from "./shell/connect"
import { enterLocation } from "./update-page"
import { placeholder } from "./page/registry"
import { readSavedEntries } from "./data/query-cache"

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
	isMobile: Schema.Boolean,
	theme: Theme,
	timeFormat: TimeFormat,
	/** Saved results younger than a day: the views stay up even if the server never answers. */
	hasSavedResults: Schema.Boolean,
})
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.all({
	env: readLocalEnv,
	rememberedRange: readRememberedRange,
	isSidebarOpen: readSidebarOpen,
	isMobile: readIsMobile,
	theme: readTheme,
	timeFormat: readTimeFormat,
	hasSavedResults: Effect.map(readSavedEntries, (entries) => entries.size > 0),
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
		timeFormat: flags.timeFormat,
		isSidebarOpen: flags.isSidebarOpen,
		isSidebarOpenMobile: false,
		isMobile: flags.isMobile,
		filterDrawer: initFilterDrawer(),
		maybeServer: Option.none(),
		probe: { isInFlight: true, version: 0 },
		hasIngested: false,
		connect: Popover.init(CONNECT_POPOVER_ID, { side: "right", align: "end", initialFocus: "first-tabbable" }),
		installTabs: Tabs.init({ idBase: 0, values: INSTALL_METHODS.map((method) => method.id), selected: INSTALL_METHODS[0]?.id ?? "" }),
		presence: AsyncData.Idle(),
		isPresenceStale: false,
		hasCache: flags.hasSavedResults,
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
