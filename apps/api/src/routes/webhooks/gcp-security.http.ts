import { Headers, HttpRouter, HttpServerResponse, type HttpServerRequest } from "effect/http"
import { Effect, Option, Result, String as Str } from "effect"
import { readBoundedText } from "@maple/backend/http/bounded-body"
import { GcpSecurityEventsService } from "@maple/backend/services/cloud-security/GcpSecurityEventsService"
import { GCP_SECURITY_PUSH_ROUTE } from "@maple/backend/services/integrations/gcp/security-push"

// Public receiver for Security Command Center notifications, pushed by the connector's Pub/Sub
// subscription. NOT behind auth: each push carries a Google-signed token naming the connector's
// push account and this URL. Pub/Sub retries any non-2xx with backoff for the subscription's
// retention (a day), so a refusal that will never pass still ends within a day.

/** A finding with its resource is a few KB; Pub/Sub caps a message at 10 MB. */
const MAX_BODY_BYTES = 512 * 1024

const textResponse = (body: string, status: number) => HttpServerResponse.text(body, { status })

const bearerOf = (request: HttpServerRequest.HttpServerRequest): Option.Option<string> =>
	Option.flatMap(Headers.get(request.headers, "authorization"), (value) =>
		Str.startsWith("Bearer ")(value) ? Option.some(Str.slice(7)(value)) : Option.none(),
	)

export const GcpSecurityEventsRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const events = yield* GcpSecurityEventsService

		const handle = Effect.fn("GcpSecurityEvents.receive")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			const params = yield* HttpRouter.params
			yield* Effect.annotateCurrentSpan({
				"http.request.method": req.method,
				"http.route": GCP_SECURITY_PUSH_ROUTE,
			})
			const respond = (status: number, outcome: string, body: string) =>
				Effect.annotateCurrentSpan({
					"http.response.status_code": status,
					"maple.gcp_security.outcome": outcome,
				}).pipe(Effect.as(textResponse(body, status)))

			const token = bearerOf(req)
			if (Option.isNone(token)) return yield* respond(403, "missing_token", "Missing push token")
			const read = yield* Effect.result(readBoundedText(req, MAX_BODY_BYTES))
			if (Result.isFailure(read)) {
				return read.failure._tag === "@maple/backend/http/RequestBodyTooLargeError"
					? yield* respond(413, "body_too_large", "Request body too large")
					: yield* respond(400, "unreadable_body", "Unreadable request body")
			}
			const receipt = yield* events.accept(params.connectorId ?? "", token.value, read.success)
			return yield* receipt.outcome === "stored"
				? respond(200, "stored", "ok")
				: respond(200, `ignored:${receipt.reason ?? "unknown"}`, "ignored")
		})

		yield* router.add("POST", GCP_SECURITY_PUSH_ROUTE, (req) =>
			handle(req).pipe(
				Effect.catchTags({
					"@maple/backend/cloud-security/GcpSecurityEventRejected": (error) =>
						Effect.succeed(
							textResponse(
								error.message,
								error.reason === "malformed" ? 400 : error.reason === "bad_token" ? 403 : 404,
							),
						),
					// A 503 is retried by Pub/Sub, so a database blip loses no notification.
					"@maple/http/errors/IntegrationsPersistenceError": (error) =>
						Effect.logError("GCP security notification could not be stored").pipe(
							Effect.annotateLogs({ message: error.message }),
							Effect.as(textResponse("Events service unavailable", 503)),
						),
				}),
			),
		)
	}),
)
