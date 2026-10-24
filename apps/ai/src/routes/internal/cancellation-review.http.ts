/**
 * `POST /internal/cancellation-review/read`: a model's second read of a plan
 * cancellation, for api's cancellation review. Reached only over the service
 * binding with the internal service token; the request carries everything the
 * model reads, so nothing of the org's is fetched here.
 */
import { CancellationReadModelError, CancellationReadUnauthorizedError, MapleAiApi } from "@maple/domain/http"
import { Effect, Layer, Option, Redacted } from "effect"
import * as AiModel from "effect/ai/Model"
import { HttpApiBuilder } from "effect/http-api"
import { Env } from "@maple/backend/platform/Env"
import { readCancellation } from "../../cancellation/cancellation-reader"
import { layerLlm, loadLlmSettings, resolveTriageModel } from "../../platform/Llm"
import { WorkersAiGateway } from "../../platform/WorkersAiHttpClient"
import { isValidServiceBearer } from "./service-bearer"

/**
 * The model the read runs on: the triage model, unattended, built once per
 * isolate from the Worker's config on the same AI Gateway binding.
 */
export const CancellationModelLive = Layer.unwrap(
	Effect.gen(function* () {
		const settings = yield* loadLlmSettings
		const workersAi = yield* WorkersAiGateway
		return resolveTriageModel(settings, undefined, true).layer.pipe(
			Layer.provide(layerLlm(settings, workersAi)),
		)
	}),
)

export const HttpCancellationReviewLive = HttpApiBuilder.group(MapleAiApi, "cancellationReview", (handlers) =>
	handlers.handle("read", ({ headers, payload }) =>
		Effect.gen(function* () {
			const config = yield* Env
			const expected = Option.map(config.INTERNAL_SERVICE_TOKEN, Redacted.value)
			if (Option.isNone(expected)) {
				return yield* new CancellationReadUnauthorizedError({
					message: "INTERNAL_SERVICE_TOKEN is not configured on maple-ai",
				})
			}
			if (!isValidServiceBearer(headers.authorization, expected.value)) {
				return yield* new CancellationReadUnauthorizedError({
					message: "internal service token rejected",
				})
			}

			return yield* readCancellation(payload, yield* AiModel.ModelName).pipe(
				Effect.mapError((error) => new CancellationReadModelError({ message: error.message })),
			)
		}),
	),
)
