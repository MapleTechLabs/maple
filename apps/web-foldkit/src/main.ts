import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { Effect, Option, Schema } from "effect"
import type { Runtime } from "foldkit"
import type { Url } from "foldkit/url"
import { CheckSession, LoadClerk } from "./command"
import type { Message } from "./message"
import { ClerkPhase, type Model, Session } from "./model"
import * as Home from "./page/home"
import * as SignIn from "./page/sign-in"
import type { Resources } from "./platform/resources"
import { readSessionToken } from "./platform/auth-api"
import { urlToAppRoute } from "./route"
import { settle } from "./update"

export { Message } from "./message"
export { Model } from "./model"
export { subscriptions } from "./subscription"
export { update } from "./update"
export { view } from "./view"

// FLAGS

/** Read before the first render, so a signed-out visit paints the page, not the boot splash. */
export const Flags = Schema.Struct({ hasStoredSession: Schema.Boolean })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.map(readSessionToken, (maybeToken) => ({
	hasStoredSession: Option.isSome(maybeToken),
}))

// INIT

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags, Resources> = (flags, url: Url) => {
	const route = urlToAppRoute(url)
	const base = { route, signIn: SignIn.init(), home: Home.init() }

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
