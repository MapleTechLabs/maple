import { Clock, Effect, Option, Redacted, Result } from "effect"
import { HttpServerResponse, type HttpServerRequest } from "effect/http"
import { readBoundedText } from "@maple/backend/http/bounded-body"
import {
	checkSvixHeaders,
	readSvixHeaders,
	verifySvixSignature,
} from "@maple/backend/services/product-events/svix"

/**
 * Shared receive step for Svix-delivered webhooks (Clerk, Autumn); authenticity is the Svix
 * signature. Headers and size are checked before the body is read; every outcome is a response
 * (503 secret unset, 401 bad headers or signature, 413 too large, 400 empty) or the verified body.
 */

/** Clerk and Autumn events are a few KB; anything this large is not one of them. */
export const SVIX_WEBHOOK_MAX_BYTES = 1024 * 1024

export type SvixReceiveOutcome =
	| { readonly _tag: "verified"; readonly body: string; readonly messageId: string }
	| { readonly _tag: "rejected"; readonly response: HttpServerResponse.HttpServerResponse }

const textResponse = (body: string, status: number) => HttpServerResponse.text(body, { status })

export const receiveSvixWebhook = (options: {
	readonly provider: "clerk" | "autumn"
	readonly secret: Option.Option<Redacted.Redacted>
	readonly request: HttpServerRequest.HttpServerRequest
}): Effect.Effect<SvixReceiveOutcome> =>
	Effect.gen(function* () {
		const attr = (key: string) => `maple.webhook.${key}`
		yield* Effect.annotateCurrentSpan({ [attr("provider")]: options.provider })

		const reject = (status: number, reason: string, body: string) =>
			Effect.annotateCurrentSpan({
				"http.response.status_code": status,
				[attr("outcome")]: "rejected",
				[attr("reason")]: reason,
			}).pipe(Effect.as<SvixReceiveOutcome>({ _tag: "rejected", response: textResponse(body, status) }))

		if (Option.isNone(options.secret)) {
			return yield* reject(503, "secret_unset", "Webhook receiver is not configured")
		}

		const headers = readSvixHeaders(options.request.headers)
		const nowMs = yield* Clock.currentTimeMillis
		const checked = yield* Effect.result(checkSvixHeaders({ headers, nowMs }))
		if (Result.isFailure(checked)) {
			return yield* reject(401, checked.failure.reason, "Invalid signature")
		}

		const read = yield* Effect.result(readBoundedText(options.request, SVIX_WEBHOOK_MAX_BYTES))
		if (Result.isFailure(read)) {
			return read.failure._tag === "@maple/backend/http/RequestBodyTooLargeError"
				? yield* reject(413, "body_too_large", "Request body too large")
				: yield* reject(400, "unreadable_body", "Unreadable request body")
		}
		const body = read.success
		if (body.length === 0) {
			return yield* reject(400, "empty_body", "Missing request body")
		}

		const verified = yield* Effect.result(
			verifySvixSignature({
				secret: Redacted.value(options.secret.value),
				headers,
				body,
				nowMs,
			}),
		)
		if (Result.isFailure(verified)) {
			return yield* reject(401, verified.failure.reason, "Invalid signature")
		}

		yield* Effect.annotateCurrentSpan({ [attr("message_id")]: checked.success.id })
		return { _tag: "verified", body, messageId: checked.success.id }
	})

export const webhookText = textResponse
