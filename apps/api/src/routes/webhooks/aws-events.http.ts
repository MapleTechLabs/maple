import { Headers, HttpRouter, HttpServerResponse, type HttpServerRequest } from "effect/http"
import { Effect, Option, Result } from "effect"
import { readBoundedText } from "@maple/backend/http/bounded-body"
import { AwsEventsRateLimiter } from "@maple/backend/services/cloud-security/AwsEventsRateLimiter"
import {
	AWS_EVENTS_KEY_HEADER,
	CloudSecurityEventsService,
} from "@maple/backend/services/cloud-security/CloudSecurityEventsService"

// Public receiver for the finding events EventBridge delivers through the API destination the AWS
// setup deploys in each region. NOT behind auth: the delivery carries the connection's events key
// in `x-maple-events-key`, and the connection id in the path says whose it is.
//
// EventBridge retries 429 and 5xx (and 401, 407, 409) for up to a day, and gives up on other 4xx:
// a refused key answers 403, so a stack left behind does not retry forever.

const ROUTE = "/api/integrations/aws/events/:connectionId"

/** EventBridge caps an event at 256 KB. */
const MAX_EVENT_BYTES = 256 * 1024

const textResponse = (body: string, status: number) => HttpServerResponse.text(body, { status })

export const AwsEventsRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const events = yield* CloudSecurityEventsService
		const rateLimiter = yield* AwsEventsRateLimiter

		const handle = Effect.fn("AwsSecurityEvents.receive")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			const params = yield* HttpRouter.params
			yield* Effect.annotateCurrentSpan({ "http.request.method": req.method, "http.route": ROUTE })
			const respond = (status: number, outcome: string, body: string) =>
				Effect.annotateCurrentSpan({
					"http.response.status_code": status,
					"maple.aws_events.outcome": outcome,
				}).pipe(Effect.as(textResponse(body, status)))

			// The key decides everything else: without one nothing is looked up and no body is read.
			const presentedKey = Headers.get(req.headers, AWS_EVENTS_KEY_HEADER)
			if (Option.isNone(presentedKey)) return yield* respond(403, "missing_key", "Invalid events key")
			const sender = yield* events.authenticate(params.connectionId ?? "", presentedKey.value)
			// Counted only for an accepted key, so the connection's budget is its key holder's to spend.
			if ((yield* rateLimiter.check(sender.connectionId)) === "limited") {
				return yield* respond(429, "rate_limited", "Too many events")
			}
			const read = yield* Effect.result(readBoundedText(req, MAX_EVENT_BYTES))
			if (Result.isFailure(read)) {
				return read.failure._tag === "@maple/backend/http/RequestBodyTooLargeError"
					? yield* respond(413, "body_too_large", "Request body too large")
					: yield* respond(400, "unreadable_body", "Unreadable request body")
			}
			const receipt = yield* events.accept(sender, read.success)
			return yield* receipt.outcome === "stored"
				? respond(200, "stored", "ok")
				: respond(200, `ignored:${receipt.reason ?? "unknown"}`, "ignored")
		})

		yield* router.add("POST", ROUTE, (req) =>
			handle(req).pipe(
				Effect.catchTags({
					"@maple/backend/cloud-security/CloudSecurityEventRejected": (error) =>
						Effect.succeed(
							textResponse(
								error.message,
								error.reason === "malformed" ? 400 : error.reason === "bad_key" ? 403 : 404,
							),
						),
					// A 503 is retried by EventBridge, so a database blip loses no event.
					"@maple/http/errors/IntegrationsPersistenceError": (error) =>
						Effect.logError("AWS security event could not be stored").pipe(
							Effect.annotateLogs({ message: error.message }),
							Effect.as(textResponse("Events service unavailable", 503)),
						),
				}),
			),
		)
	}),
)
