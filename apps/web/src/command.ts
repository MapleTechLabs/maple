import { DashboardWidgetSchema } from "@maple/domain/http"
import { mutateDashboard } from "./page/dashboards/kit/store"
import { Clock, Duration, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { load, pushUrl, replaceUrl } from "foldkit/navigation"
import { Message } from "./message"
import { PRELOAD_HOLD_MS } from "./page/preload"
import { clearSessionToken, MapleAuthApi, readSessionToken, saveSessionToken } from "./platform/auth-api"
import { saveSelectedPlanKnown } from "./page/onboarding/plan-gate"
import { loadClerk, signOutOfClerk } from "./platform/clerk"
import { BillingCustomerCache } from "./data/billing-customer"
import { IntegrationStatuses } from "./data/integration-statuses"
import { ReadCache } from "./data/read-cache"
import { OrgCollections } from "./data/collections/org-collections"
import { readSessionTimeRange, writeSessionTimeRange } from "./platform/session-time-range"
import { SessionTimeRange } from "./route/session-time-range"
import { identifySession } from "./data/analytics"
import { SessionIdentity } from "./platform/session-identity"

/** How long a signed-out Clerk answer may still turn into a session on a hard refresh. */
const AUTH_SETTLE_TIMEOUT = Duration.seconds(2)

/** `retryOrgCollections`: a fresh collection set; every live query moves onto it. */
export const ReconnectOrgCollections = Command.define("ReconnectOrgCollections", {
	messages: [Message.CompletedReconnectOrgCollections],
	execute: Effect.gen(function* () {
		yield* (yield* OrgCollections).recreate
		return Message.CompletedReconnectOrgCollections()
	}),
})

/** A dashboard toast's Undo: the removed widgets back on the board, wherever the user is now. */
export const RestoreDashboardWidgets = Command.define("RestoreDashboardWidgets", {
	args: { orgId: Schema.String, dashboardId: Schema.String, widgets: Schema.Array(DashboardWidgetSchema) },
	messages: [Message.CompletedRestoreDashboardWidgets],
	execute: ({ orgId, dashboardId, widgets }) =>
		mutateDashboard(orgId, dashboardId, (document, nowIso) => {
			const missing = widgets.filter(
				(widget) => !document.widgets.some((existing) => existing.id === widget.id),
			)
			return missing.length === 0
				? document
				: { ...document, widgets: [...document.widgets, ...missing], updatedAt: nowIso }
		}).pipe(Effect.ignore, Effect.as(Message.CompletedRestoreDashboardWidgets())),
})

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
		Effect.catchTag("@maple/web/SessionCheckError", (error) =>
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
		Effect.catchTag("@maple/web/ClerkLoadError", (error) =>
			Effect.succeed(Message.FailedLoadClerk({ message: error.message })),
		),
	),
})

export const WaitForAuthSettle = Command.define("WaitForAuthSettle", {
	messages: [Message.CompletedWaitForAuthSettle],
	execute: Effect.sleep(AUTH_SETTLE_TIMEOUT).pipe(Effect.as(Message.CompletedWaitForAuthSettle())),
})

/** The Clerk user menu's Log out: `signOut()`, after which Clerk emits the signed-out session. */
export const SignOutOfClerk = Command.define("SignOutOfClerk", {
	messages: [Message.CompletedSignOutOfClerk],
	execute: signOutOfClerk.pipe(Effect.as(Message.CompletedSignOutOfClerk())),
})

/** `ClerkAuthBridge`'s `identify(...)`: the session's rows and product events name the user and org. */
export const IdentifySession = Command.define("IdentifySession", {
	args: { identity: Schema.NullOr(SessionIdentity) },
	messages: [Message.CompletedIdentifySession],
	execute: ({ identity }) => identifySession(identity).pipe(Effect.as(Message.CompletedIdentifySession())),
})

/** `billingCustomerAtom`: `GET /internal/billing/customer`, for the org it was asked for. */
export const LoadCustomer = Command.define("LoadCustomer", {
	args: { orgId: Schema.String, refresh: Schema.Boolean },
	messages: [Message.SucceededLoadCustomer, Message.FailedLoadCustomer],
	execute: ({ orgId, refresh }) =>
		Effect.gen(function* () {
			const customer = yield* (yield* BillingCustomerCache).get({ refresh })
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

/**
 * A holder let go of these reads (a page left, a preload's hold ran out): their idle TTL starts. A
 * new page instance also names its org, which drops another org's reads.
 */
export const ReleaseReads = Command.define("ReleaseReads", {
	args: { orgId: Schema.NullOr(Schema.String), keys: Schema.Array(Schema.String) },
	messages: [Message.CompletedReleaseReads],
	execute: ({ orgId, keys }) =>
		Effect.gen(function* () {
			const cache = yield* ReadCache
			if (orgId !== null) {
				yield* cache.scopeTo(orgId)
				// Pages read the integration statuses without naming their org.
				yield* (yield* IntegrationStatuses).scopeTo(orgId)
			}
			yield* cache.release(keys)
			return Message.CompletedReleaseReads()
		}),
})

/** The tab's remembered window for the org, with the clock its presets resolve against. */
export const ReadSessionTimeRange = Command.define("ReadSessionTimeRange", {
	args: { orgId: Schema.String },
	messages: [Message.LoadedSessionTimeRange],
	execute: ({ orgId }) =>
		Effect.map(Effect.all([readSessionTimeRange(orgId), Clock.currentTimeMillis]), ([value, nowMs]) =>
			Message.LoadedSessionTimeRange({ orgId, value, nowMs }),
		),
})

/** `persistSessionTimeRange`: the window a settled navigation carried. */
export const WriteSessionTimeRange = Command.define("WriteSessionTimeRange", {
	args: { orgId: Schema.String, value: SessionTimeRange },
	messages: [Message.CompletedWriteSessionTimeRange],
	execute: ({ orgId, value }) =>
		Effect.andThen(writeSessionTimeRange(orgId, value), Clock.currentTimeMillis).pipe(
			Effect.map((nowMs) => Message.CompletedWriteSessionTimeRange({ nowMs })),
		),
})
