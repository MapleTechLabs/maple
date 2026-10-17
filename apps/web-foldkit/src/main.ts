import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { Effect, Option, Schema } from "effect"
import type { Runtime } from "foldkit"
import type { Url } from "foldkit/url"
import { CheckSession, LoadClerk } from "./command"
import type { Message } from "./message"
import { ClerkPhase, type Model, Session } from "./model"
import * as SignIn from "./page/sign-in"
import type { Resources } from "./platform/api-clients"
import { readSessionToken } from "./platform/auth-api"
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
	shell: Schema.Struct({
		isMobile: Schema.Boolean,
		theme: Shell.Theme,
		pinnedNamespaces: Schema.Record(Schema.String, Schema.String),
		dashboardFavorites: Schema.Array(Schema.String),
	}),
})
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.all({
	hasStoredSession: Effect.map(readSessionToken, Option.isSome),
	shell: Shell.readShellFlags,
})

// INIT

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags, Resources> = (flags, url: Url) => {
	const route = urlToAppRoute(url)
	const base = { route, signIn: SignIn.init(), shell: Shell.init(flags.shell) }

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
