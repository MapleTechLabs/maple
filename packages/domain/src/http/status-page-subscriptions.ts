import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { StatusPageComponentId, StatusPageId } from "../primitives"
import { HttpTaggedError } from "./error-policy"

/** The page is gone, unpublished, or its org is out of the status pages rollout. */
export class StatusPageSubscriptionPageNotFoundError extends HttpTaggedError<StatusPageSubscriptionPageNotFoundError>()(
	"@maple/http/errors/StatusPageSubscriptionPageNotFoundError",
	{ pageId: StatusPageId, message: Schema.String },
	{
		status: 404,
		code: "status_page_not_found",
		title: "Status page not found",
		message: "No such status page.",
		param: "pageId",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class StatusPageSubscriptionInvalidError extends HttpTaggedError<StatusPageSubscriptionInvalidError>()(
	"@maple/http/errors/StatusPageSubscriptionInvalidError",
	{ message: Schema.String },
	{
		status: 400,
		code: "status_page_subscription_invalid",
		title: "Invalid subscription",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** A confirmation or unsubscribe link that is malformed, expired or already used. */
export class StatusPageSubscriptionTokenInvalidError extends HttpTaggedError<StatusPageSubscriptionTokenInvalidError>()(
	"@maple/http/errors/StatusPageSubscriptionTokenInvalidError",
	{ message: Schema.String },
	{
		status: 400,
		code: "status_page_subscription_token_invalid",
		title: "Invalid or expired link",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

export class StatusPageSubscriptionUnavailableError extends HttpTaggedError<StatusPageSubscriptionUnavailableError>()(
	"@maple/http/errors/StatusPageSubscriptionUnavailableError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
	{
		status: 503,
		code: "status_page_subscriptions_unavailable",
		title: "Subscriptions are temporarily unavailable",
		message: "Subscriptions are temporarily unavailable. Retry in a minute.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export const STATUS_PAGE_SUBSCRIBER_EMAIL_MAX_LENGTH = 254

export const StatusPageSubscribeRequest = Schema.Struct({
	email: Schema.String.check(Schema.isMaxLength(STATUS_PAGE_SUBSCRIBER_EMAIL_MAX_LENGTH)),
	/** Absent: every component, including ones added later. */
	componentIds: Schema.optionalKey(Schema.Array(StatusPageComponentId).check(Schema.isMaxLength(200))),
})
export type StatusPageSubscribeRequest = Schema.Schema.Type<typeof StatusPageSubscribeRequest>

/** Tokens travel in the body, never the URL, so no access log or span records them. */
export const StatusPageSubscriptionTokenRequest = Schema.Struct({
	token: Schema.String.check(Schema.isMaxLength(256)),
})

const PagePath = Schema.Struct({ pageId: StatusPageId })

const ERRORS = [StatusPageSubscriptionPageNotFoundError, StatusPageSubscriptionUnavailableError] as const

/**
 * Unauthenticated, called by the status Worker for a visitor's form. Subscribing answers the same
 * whether or not the address is already on the list. Every link in the emails is built from the
 * deployment's own status page origin, never from anything the caller sends.
 */
export class StatusPageSubscriptionsPublicApiGroup extends HttpApiGroup.make("statusPageSubscriptions")
	.add(
		HttpApiEndpoint.post("subscribe", "/:pageId/subscribe", {
			params: PagePath,
			payload: StatusPageSubscribeRequest,
			success: Schema.Void,
			error: [...ERRORS, StatusPageSubscriptionInvalidError],
		}),
	)
	.add(
		HttpApiEndpoint.post("confirm", "/:pageId/confirm", {
			params: PagePath,
			payload: StatusPageSubscriptionTokenRequest,
			success: Schema.Void,
			error: [...ERRORS, StatusPageSubscriptionTokenInvalidError],
		}),
	)
	.add(
		HttpApiEndpoint.post("unsubscribe", "/:pageId/unsubscribe", {
			params: PagePath,
			payload: StatusPageSubscriptionTokenRequest,
			success: Schema.Void,
			error: [...ERRORS, StatusPageSubscriptionTokenInvalidError],
		}),
	)
	.prefix("/api/status-pages/public") {}
