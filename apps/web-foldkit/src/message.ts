import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { UrlRequest } from "foldkit/navigation"
import { Url } from "foldkit/url"
import * as Home from "./page/home"
import * as SignIn from "./page/sign-in"
import { ClerkSnapshot } from "./platform/clerk"

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
	CompletedMountClerkSignIn: {},
	FailedMountClerkSignIn: { message: Schema.String },
	GotSignInMessage: { message: SignIn.Message },
	GotHomeMessage: { message: Home.Message },
})
export type Message = typeof Message.Type
