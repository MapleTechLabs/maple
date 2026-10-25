import { OrgId } from "@maple/domain"
import { BillingCustomer } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { UrlRequest } from "foldkit/navigation"
import { Url } from "foldkit/url"
import * as Onboarding from "./page/onboarding"
import { PageMessage } from "./page/registry"
import * as SignIn from "./page/sign-in"
import { ClerkSnapshot } from "./platform/clerk"
import { SessionTimeRange } from "./route/session-time-range"
import * as Shell from "./shell"
import * as ChatSheet from "./page/chat/sheet"
import * as Toast from "./ui/toast"

/** Why the stored self-hosted session did not resolve to a signed-in tenant. */
export const SessionCheckFailure = Schema.Literals(["NoToken", "Rejected", "Unreachable"])
export type SessionCheckFailure = typeof SessionCheckFailure.Type

export const Message = defineMessageUnion({
	ClickedLink: { request: UrlRequest },
	ChangedUrl: { url: Url },
	CompletedNavigateInternal: {},
	CompletedReplaceUrl: {},
	CompletedLoadExternal: {},
	SucceededCheckSession: { orgId: OrgId },
	FailedCheckSession: { failure: SessionCheckFailure },
	ChangedSelfHostedSession: {},
	CompletedSaveSessionToken: {},
	CompletedLoadClerk: { snapshot: ClerkSnapshot },
	FailedLoadClerk: { message: Schema.String },
	ChangedClerkSession: { snapshot: ClerkSnapshot },
	CompletedWaitForAuthSettle: {},
	SucceededLoadCustomer: { orgId: Schema.String, customer: BillingCustomer },
	FailedLoadCustomer: { orgId: Schema.String },
	/** The plan gate's splash waited out its grace: a slow customer read no longer holds the app. */
	ElapsedCustomerGrace: { orgId: Schema.String },
	CompletedSaveSelectedPlanKnown: {},
	CompletedReconnectOrgCollections: {},
	CompletedRestoreDashboardWidgets: {},
	CompletedSignOutOfClerk: {},
	/** The Clerk identity was handed to the telemetry session (`identify`). */
	CompletedIdentifySession: {},
	GotSignInMessage: { message: SignIn.Message },
	GotShellMessage: { message: Shell.Message },
	GotToastMessage: { message: Toast.Message },
	GotPageMessage: { message: PageMessage },
	GotChatSheetMessage: { message: ChatSheet.Message },
	GotOnboardingMessage: { message: Onboarding.Message },
	/** Link intent (`page/preload.ts`): hovered, focused or touched; left or blurred. */
	IntendedLink: { href: Schema.String, isImmediate: Schema.Boolean },
	EndedLinkIntent: { href: Schema.String },
	ElapsedPreloadDelay: { href: Schema.String, version: Schema.Number, nowMs: Schema.Number },
	GotPreloadMessage: { message: PageMessage },
	ExpiredPreloads: { keys: Schema.Array(Schema.String) },
	CompletedReleaseReads: {},
	LoadedSessionTimeRange: { orgId: Schema.String, value: SessionTimeRange, nowMs: Schema.Number },
	CompletedWriteSessionTimeRange: { nowMs: Schema.Number },
	/** `timezonePreferenceAtom` changed (a pick here, or another tab's `storage` event): the effective zone. */
	ChangedTimeZonePreference: { timeZone: Schema.String },
})
export type Message = typeof Message.Type
