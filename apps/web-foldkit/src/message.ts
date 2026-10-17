import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { UrlRequest } from "foldkit/navigation"
import { Url } from "foldkit/url"
import { PageMessage } from "./page/registry"
import * as SignIn from "./page/sign-in"
import { ClerkSnapshot } from "./platform/clerk"
import * as Shell from "./shell"
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
	CompletedMountClerkSignIn: {},
	FailedMountClerkSignIn: { message: Schema.String },
	GotSignInMessage: { message: SignIn.Message },
	GotShellMessage: { message: Shell.Message },
	GotToastMessage: { message: Toast.Message },
	GotPageMessage: { message: PageMessage },
})
export type Message = typeof Message.Type
