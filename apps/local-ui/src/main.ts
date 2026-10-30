import { Effect, Layer, Option, Schema } from "effect"
import { AsyncData, Block } from "foldkit"
import type { Url } from "foldkit/url"
import { ApplyTheme, CommandsLayer, ProbeServer } from "./command"
import { ApplicationComposition } from "./composition"
import { LocalEnv, readIsMobile, readLocalEnv, readRememberedRange, readSidebarOpen, readTheme, readTimeFormat, Theme } from "./env"
import { TimeFormat } from "./page/kit/local-time"
import { Model } from "./model"
import { hashOf, locationOf, routeOf } from "./navigation"
import { EffectsLayer as CopiesEffectsLayer } from "./page/kit/copies"
import { placeholder } from "./page/page-model"
import { readSavedEntries } from "./data/query-cache"
import { subscriptions } from "./subscription"
import { update } from "./update"
import { enterLocationStep } from "./update-page"
import { view } from "./view"

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

/** The shell's connect popover, install tabs, drawer and toasts start through their Bindings. */
export const init = ApplicationComposition.makeInit((flags: Flags, url: Url) => {
	const location = locationOf(url)
	return {
		model: {
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
			maybeServer: Option.none(),
			probe: { isInFlight: true, version: 0 },
			hasIngested: false,
			presence: AsyncData.Idle(),
			isPresenceStale: false,
			hasCache: flags.hasSavedResults,
			copies: {},
			page: placeholder(""),
		},
		commands: [ApplyTheme({ theme: flags.theme }), ProbeServer({ apiBase: flags.env.apiBase })],
		steps: [enterLocationStep(null)],
	}
})

/** The root's own handlers; every child Block brings its own through its Binding. */
const EffectsLayer = Layer.mergeAll(CommandsLayer, CopiesEffectsLayer, subscriptions.layer)

const prepare = () => ApplicationComposition.prepareBlock({ init, update, view, subscriptions, EffectsLayer })
export const ApplicationBlock: Block.FromAssemblyWithView<typeof Model, typeof prepare> = Block.assemble(prepare)
