import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Option } from "effect"
import type { VcsProviderClient } from "../services/vcs/VcsProviderClient"
import { VcsProviderRegistry } from "../services/vcs/VcsProviderRegistry"
import { VcsSyncQueue } from "../services/vcs/VcsSyncQueue"

// ---------------------------------------------------------------------------
// Public webhook receiver, one static route per registered provider
// (`/api/integrations/<provider>/webhook`). Generic pipeline: the provider
// verifies the signature + maps the event to jobs; this router just enqueues
// and returns 202. NOT behind auth — authenticity comes from the provider's
// signature check.
// ---------------------------------------------------------------------------

const textResponse = (body: string, status: number) => HttpServerResponse.text(body, { status })

export const VcsWebhookRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const registry = yield* VcsProviderRegistry
		const queue = yield* VcsSyncQueue

		const makeHandler =
			(provider: VcsProviderClient) => (req: HttpServerRequest.HttpServerRequest) =>
				Effect.gen(function* () {
					const bodyOpt = yield* req.text.pipe(Effect.option)
					if (Option.isNone(bodyOpt)) return textResponse("Missing request body", 400)
					const headers = req.headers as Record<string, string | undefined>

					return yield* provider.webhookToJobs({ headers, rawBody: bodyOpt.value }).pipe(
						Effect.flatMap((jobs) =>
							Effect.forEach(jobs, (job) => queue.send(job), { discard: true }).pipe(
								Effect.as(textResponse("accepted", 202)),
							),
						),
						Effect.catchTags({
							"@maple/http/errors/VcsWebhookSignatureError": (error) =>
								Effect.succeed(textResponse(error.message, 401)),
							"@maple/http/errors/VcsWebhookParseError": (error) =>
								Effect.succeed(textResponse(error.message, 400)),
							"@maple/http/errors/VcsQueueError": (error) =>
								Effect.logError("Failed to enqueue VCS webhook jobs")
									.pipe(Effect.annotateLogs({ error: error.message }))
									.pipe(Effect.as(textResponse("enqueue failed", 500))),
						}),
					)
				}).pipe(Effect.withSpan("VcsWebhook.receive", { attributes: { "vcs.provider": provider.id } }))

		yield* Effect.forEach(
			registry.ids,
			(id) =>
				registry
					.resolve(id)
					.pipe(
						Effect.orDie,
						Effect.flatMap((provider) =>
							router.add("POST", `/api/integrations/${id}/webhook`, makeHandler(provider)),
						),
					),
			{ discard: true },
		)
	}),
)
