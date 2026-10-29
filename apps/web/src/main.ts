import { isClerkAuthEnabled } from "./lib/services/common/auth-mode"
import { Effect, Option, Schema } from "effect"
import type { Runtime } from "foldkit"
import type { Url } from "foldkit/url"
import { CheckSession, LoadClerk } from "./command"
import type { Message } from "./message"
import { ClerkPhase, type Model, Session } from "./model"
import { initCustomer, readKnownToRenderApp } from "./page/onboarding/plan-gate"
import * as Preload from "./page/preload"
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
		return {
			model: { ...base, session: Session.Resolving(), clerk: ClerkPhase.Loading() },
			commands: [LoadClerk()],
		}
	}

	if (flags.hasStoredSession) {
		return {
			model: { ...base, session: Session.Resolving(), clerk: ClerkPhase.Unused() },
			commands: [CheckSession()],
		}
	}

	return settle({ ...base, session: Session.SignedOut(), clerk: ClerkPhase.Unused() })
}
