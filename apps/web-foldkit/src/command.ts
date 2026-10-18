import { Clock, Duration, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { load, pushUrl, replaceUrl } from "foldkit/navigation"
import { Message } from "./message"
import { PRELOAD_HOLD_MS } from "./page/preload"
import { PageMessage } from "./page/registry"
import { clearSessionToken, MapleAuthApi, readSessionToken, saveSessionToken } from "./platform/auth-api"
import { loadClerk } from "./platform/clerk"

/** How long a signed-out Clerk answer may still turn into a session on a hard refresh (main.tsx). */
const AUTH_SETTLE_TIMEOUT = Duration.seconds(2)

export const NavigateInternal = Command.define("NavigateInternal", {
	args: { url: Schema.String },
	messages: [Message.CompletedNavigateInternal],
	execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
})

export const ReplaceUrl = Command.define("ReplaceUrl", {
	args: { url: Schema.String },
	messages: [Message.CompletedReplaceUrl],
	execute: ({ url }) => replaceUrl(url).pipe(Effect.as(Message.CompletedReplaceUrl())),
})

export const LoadExternal = Command.define("LoadExternal", {
	args: { href: Schema.String },
	messages: [Message.CompletedLoadExternal],
	execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
})

/** `resolveSelfHostedRouterAuth`: a rejected token is cleared, an unreachable API keeps it. */
export const CheckSession = Command.define("CheckSession", {
	messages: [Message.SucceededCheckSession, Message.FailedCheckSession],
	execute: Effect.gen(function* () {
		const maybeToken = yield* readSessionToken
		if (Option.isNone(maybeToken)) {
			return Message.FailedCheckSession({ failure: "NoToken" })
		}
		const auth = yield* MapleAuthApi
		const tenant = yield* auth.session(maybeToken.value)
		return Message.SucceededCheckSession({ orgId: tenant.orgId })
	}).pipe(
		Effect.catchTag("@maple/web-foldkit/SessionCheckError", (error) =>
			error.reason === "Rejected"
				? Effect.as(clearSessionToken, Message.FailedCheckSession({ failure: "Rejected" }))
				: Effect.succeed(Message.FailedCheckSession({ failure: "Unreachable" })),
		),
	),
})

export const SaveSessionToken = Command.define("SaveSessionToken", {
	args: { token: Schema.String },
	messages: [Message.CompletedSaveSessionToken],
	execute: ({ token }) => saveSessionToken(token).pipe(Effect.as(Message.CompletedSaveSessionToken())),
})

export const LoadClerk = Command.define("LoadClerk", {
	messages: [Message.CompletedLoadClerk, Message.FailedLoadClerk],
	execute: loadClerk.pipe(
		Effect.map((snapshot) => Message.CompletedLoadClerk({ snapshot })),
		Effect.catchTag("@maple/web-foldkit/ClerkLoadError", (error) =>
			Effect.succeed(Message.FailedLoadClerk({ message: error.message })),
		),
	),
})

export const WaitForAuthSettle = Command.define("WaitForAuthSettle", {
	messages: [Message.CompletedWaitForAuthSettle],
	execute: Effect.sleep(AUTH_SETTLE_TIMEOUT).pipe(Effect.as(Message.CompletedWaitForAuthSettle())),
})

/** TanStack's intent timer: the link stayed hovered or focused for `delayMs`. */
export const WaitPreloadDelay = Command.define("WaitPreloadDelay", {
	args: { href: Schema.String, version: Schema.Number, delayMs: Schema.Number },
	messages: [Message.ElapsedPreloadDelay],
	execute: ({ href, version, delayMs }) =>
		Effect.sleep(Duration.millis(delayMs)).pipe(
			Effect.andThen(Clock.currentTimeMillis),
			Effect.map((nowMs) => Message.ElapsedPreloadDelay({ href, version, nowMs })),
		),
})

/** `warmAtoms`' hold: unused preloads are released after it. */
export const HoldPreloads = Command.define("HoldPreloads", {
	args: { keys: Schema.Array(Schema.String) },
	messages: [Message.ExpiredPreloads],
	execute: ({ keys }) =>
		Effect.sleep(Duration.millis(PRELOAD_HOLD_MS)).pipe(Effect.as(Message.ExpiredPreloads({ keys }))),
})

/** A preloaded answer handed to the page that asked for it, instead of a second request. */
export const DeliverPreloaded = Command.define("DeliverPreloaded", {
	args: { message: PageMessage },
	messages: [Message.GotPageMessage],
	execute: ({ message }) => Effect.succeed(Message.GotPageMessage({ message })),
})
