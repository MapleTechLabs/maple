import { isClerkAuthEnabled } from "./lib/services/common/auth-mode"
import { Effect, Option, Schema } from "effect"
import type { Command, Runtime } from "foldkit"
import type { Url } from "foldkit/url"
import { CheckSession, LoadClerk, LoadPageCode } from "./command"
import type { Message } from "./message"
import { ClerkPhase, type Model, PageCode, Session } from "./model"
import { initCustomer, readKnownToRenderApp } from "./page/onboarding/plan-gate"
import * as Preload from "./page/preload"
import { unloadedPageOf } from "./page/registry"
import * as SignIn from "./page/sign-in"
import type { Resources } from "./platform/resources"
import { readSessionToken } from "./platform/auth-api"
import { readEffectiveTimeZone } from "./platform/time-zone"
import * as Toast from "./ui/toast"
import { urlToAppRoute } from "./route"
import * as Shell from "./shell"
import { settle } from "./update"

export { Message } from "./message"
export { Model } from "./model"
export { subscriptions } from "./subscription"
export { update } from "./update"
export { view } from "./view"

// FLAGS

/** Read before the first render, so a signed-out visit paints the page, not the boot splash. */
export const Flags = Schema.Struct({
	hasStoredSession: Schema.Boolean,
	timeZone: Schema.String,
	knownToRenderApp: Schema.Record(Schema.String, Schema.Boolean),
	shell: Schema.Struct({
		isMobile: Schema.Boolean,
		isFilterCollapsed: Schema.optionalKey(Schema.Boolean),
		isBelowSm: Schema.optionalKey(Schema.Boolean),
		theme: Shell.Theme,
		pinnedNamespaces: Schema.Record(Schema.String, Schema.String),
		dashboardFavorites: Schema.Array(Schema.String),
		rememberedSurfaces: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Shell.NavSurface))),
		isQuotaApproachingDismissed: Schema.optionalKey(Schema.Boolean),
	}),
})
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.all({
	hasStoredSession: Effect.map(readSessionToken, Option.isSome),
	timeZone: readEffectiveTimeZone,
	knownToRenderApp: readKnownToRenderApp,
	shell: Shell.readShellFlags,
})

// INIT

/** The route's page code loads alongside the session, so the page can enter once it resolves. */
const withRoutePageCode = (model: Model, sessionCommand: Command.Command<Message, never, Resources>) =>
	Option.match(unloadedPageOf(model.route), {
		onNone: () => ({ model, commands: [sessionCommand] }),
		onSome: (pageId) => ({
			model: { ...model, pageCode: PageCode.Loading({ pageId }) },
			commands: [sessionCommand, LoadPageCode({ pageId, preloadHref: null })],
		}),
	})

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags, Resources> = (flags, url: Url) => {
	const route = urlToAppRoute(url)
	const base = {
		route,
		signIn: SignIn.init(),
		shell: Shell.init(flags.shell),
		toasts: Toast.init("toasts"),
		toastActions: {},
		toastRootActions: {},
		page: null,
		pageCode: PageCode.Ready(),
		pageInstances: 0,
		parkedPages: [],
		onboarding: null,
		clerkSnapshot: null,
		customer: initCustomer(),
		knownToRenderApp: flags.knownToRenderApp,
		preload: Preload.init(),
		sessionTimeRange: null,
		timeZone: flags.timeZone,
	}

	if (isClerkAuthEnabled) {
		return withRoutePageCode(
			{ ...base, session: Session.Resolving(), clerk: ClerkPhase.Loading() },
			LoadClerk(),
		)
	}

	if (flags.hasStoredSession) {
		return withRoutePageCode(
			{ ...base, session: Session.Resolving(), clerk: ClerkPhase.Unused() },
			CheckSession(),
		)
	}

	return settle({ ...base, session: Session.SignedOut(), clerk: ClerkPhase.Unused() })
}
