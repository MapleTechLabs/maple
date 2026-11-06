import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/http"
import { Effect, Result, Schema } from "effect"
import { readBoundedText } from "@maple/backend/http/bounded-body"
import type { VcsProviderClient } from "@maple/backend/services/integrations/vcs/VcsProviderClient"
import { VcsProviderRegistry } from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { VcsSyncQueue } from "@maple/backend/services/integrations/vcs/VcsSyncQueue"

/**
 * In-memory sentinel: lets the span exit Error while the HTTP layer returns a
 * 500. Failed immediately after the span annotation, then caught outside the
 * span (never serialized).
 */
class EnqueueFailure extends Schema.TaggedError<EnqueueFailure>()(
	"@maple/api/routes/VcsWebhookEnqueueFailure",
	{ message: Schema.String },
) {}

// Public webhook receiver, one static route per registered provider
// (`/api/integrations/<provider>/webhook`). Generic pipeline: the provider
// verifies the signature + maps the event to jobs; this router just enqueues
// and returns 202. NOT behind auth — authenticity comes from the provider's
// signature check.

const textResponse = (body: string, status: number) => HttpServerResponse.text(body, { status })

/** GitHub does not deliver payloads over 25 MB, so a larger body is never a real delivery. */
export const VCS_WEBHOOK_MAX_BYTES = 25 * 1024 * 1024

export const VcsWebhookRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const registry = yield* VcsProviderRegistry
		const queue = yield* VcsSyncQueue

		const makeHandler =
			(provider: VcsProviderClient, route: string) => (req: HttpServerRequest.HttpServerRequest) => {
				return Effect.gen(function* () {
					const deliveryId = (req.headers as Record<string, string | undefined>)[
						"x-github-delivery"
					]
					yield* Effect.annotateCurrentSpan({
						"http.request.method": req.method,
						"http.route": route,
						...(deliveryId ? { "vcs.webhook.delivery_id": deliveryId } : undefined),
					})

					const rejected = (status: number, reason: string, body: string) =>
						Effect.annotateCurrentSpan({
							"http.response.status_code": status,
							"vcs.webhook.outcome": "rejected",
							"vcs.webhook.reason": reason,
						}).pipe(Effect.as(textResponse(body, status)))

					const headers = req.headers as Record<string, string | undefined>
					// Refused before the body is read: nothing unsigned or oversized is buffered.
					if (!headers[provider.webhookSignatureHeader]) {
						return yield* rejected(401, "missing_signature", "Missing webhook signature")
					}
					const read = yield* Effect.result(readBoundedText(req, VCS_WEBHOOK_MAX_BYTES))
					if (Result.isFailure(read)) {
						return read.failure._tag === "@maple/backend/http/RequestBodyTooLargeError"
							? yield* rejected(413, "body_too_large", "Request body too large")
							: yield* rejected(400, "unreadable_body", "Unreadable request body")
					}
					if (read.success.length === 0) {
						yield* Effect.logInfo("[VCS] webhook rejected: empty request body")
						return yield* rejected(400, "empty_body", "Missing request body")
					}

					return yield* provider.webhookToJobs({ headers, rawBody: read.success }).pipe(
						Effect.flatMap((jobs) =>
							queue.sendBatch(jobs).pipe(
								Effect.flatMap(() =>
									Effect.annotateCurrentSpan({
										"http.response.status_code": 202,
										"vcs.webhook.outcome": "handled",
										"vcs.webhook.jobs_enqueued": jobs.length,
									}),
								),
								Effect.as(textResponse("accepted", 202)),
							),
						),
						Effect.catchTags({
							"@maple/http/errors/VcsWebhookSignatureError": (error) =>
								Effect.annotateCurrentSpan({
									"http.response.status_code": 401,
									"error.type": error._tag,
									"vcs.webhook.outcome": "rejected",
									"vcs.webhook.reason": "signature_rejected",
								}).pipe(Effect.as(textResponse(error.message, 401))),
							"@maple/http/errors/VcsWebhookParseError": (error) =>
								Effect.annotateCurrentSpan({
									"http.response.status_code": 400,
									"error.type": error._tag,
									"vcs.webhook.outcome": "rejected",
									"vcs.webhook.reason": "parse_rejected",
								}).pipe(Effect.as(textResponse(error.message, 400))),
							// Annotate + fail so the span exits Error; caught below for the 500 body.
							"@maple/http/errors/VcsQueueError": (error) =>
								Effect.annotateCurrentSpan({
									"http.response.status_code": 500,
									"error.type": error._tag,
									"vcs.webhook.outcome": "failed",
									"vcs.webhook.reason": "enqueue_failed",
								}).pipe(
									Effect.flatMap(() =>
										Effect.logError("[VCS] failed to enqueue webhook jobs").pipe(
											Effect.annotateLogs({ error: error.message }),
										),
									),
									Effect.flatMap(() =>
										Effect.fail(new EnqueueFailure({ message: error.message })),
									),
								),
						}),
					)
				}).pipe(
					// Span status comes from the Effect exit, not an attribute — a rejection
					// that returns a response exits Ok, and only the enqueue failure below
					// propagates far enough to mark this span Error. Do NOT hand-stamp an
					// `otel.status_code` attribute here: this SDK never reads it (that
					// spelling is load-bearing only in the Rust gateway's tracing bridge), so
					// it is dead weight that reads as authoritative.
					Effect.withSpan("VcsWebhook.receive", {
						attributes: { "vcs.provider": provider.id },
					}),
					// Catch OUTSIDE the span so the span exits Error but HTTP gets a 500.
					Effect.catchTag("@maple/api/routes/VcsWebhookEnqueueFailure", () =>
						Effect.succeed(textResponse("enqueue failed", 500)),
					),
				)
			}

		yield* Effect.forEach(
			registry.ids,
			(id) =>
				registry
					.resolve(id)
					.pipe(
						Effect.flatMap((provider) =>
							router.add(
								"POST",
								`/api/integrations/${id}/webhook`,
								makeHandler(provider, `/api/integrations/${id}/webhook`),
							),
						),
					),
			{ discard: true },
		)
	}),
)
