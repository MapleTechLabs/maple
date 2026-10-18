import { Duration, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { load, pushUrl, replaceUrl } from "foldkit/navigation"
import { Message } from "./message"
import { clearSessionToken, MapleAuthApi, readSessionToken, saveSessionToken } from "./platform/auth-api"
import { saveSelectedPlanKnown } from "./page/onboarding/plan-gate"
import { MapleInternalApiClient } from "./platform/api-clients"
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

/** `billingCustomerAtom`: `GET /internal/billing/customer`, for the org it was asked for. */
export const LoadCustomer = Command.define("LoadCustomer", {
	args: { orgId: Schema.String },
	messages: [Message.SucceededLoadCustomer, Message.FailedLoadCustomer],
	execute: ({ orgId }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const customer = yield* client.billing.getCustomer()
			return Message.SucceededLoadCustomer({ orgId, customer })
		}).pipe(Effect.orElseSucceed(() => Message.FailedLoadCustomer({ orgId }))),
})

/** The plan settled: remember whether this org may render the app (`selectedPlanKnownAtomFor`). */
export const SaveSelectedPlanKnown = Command.define("SaveSelectedPlanKnown", {
	args: { orgId: Schema.String, mayRenderApp: Schema.Boolean },
	messages: [Message.CompletedSaveSelectedPlanKnown],
	execute: ({ orgId, mayRenderApp }) =>
		saveSelectedPlanKnown(orgId, mayRenderApp).pipe(Effect.as(Message.CompletedSaveSelectedPlanKnown())),
})
