/**
 * `POST /internal/cancellation-review/read`: a model's second read of a plan
 * cancellation, for api's cancellation review. Reached only over the service
 * binding with the internal service token; the request carries everything the
 * model reads, so nothing of the org's is fetched here.
 */
import { CancellationReadModelError, CancellationReadUnauthorizedError, MapleAiApi } from "@maple/domain/http"
import { Effect, Layer } from "effect"
import * as AiModel from "effect/ai/Model"
import { HttpApiBuilder } from "effect/http-api"
import { readCancellation } from "../../cancellation/cancellation-reader"
import { layerLlm, loadLlmSettings, resolveCancellationModel } from "../../platform/Llm"
import { requireInternalServiceBearer } from "../../platform/internal-service-token"
import { WorkersAiGateway } from "../../platform/WorkersAiHttpClient"

/** The model the read runs on, built once per isolate on the Worker's AI Gateway binding. */
export const CancellationModelLive = Layer.unwrap(
	Effect.gen(function* () {
		const settings = yield* loadLlmSettings
		const workersAi = yield* WorkersAiGateway
		return resolveCancellationModel(settings).layer.pipe(Layer.provide(layerLlm(settings, workersAi)))
	}),
)

export const HttpCancellationReviewLive = HttpApiBuilder.group(MapleAiApi, "cancellationReview", (handlers) =>
	handlers.handle("read", ({ headers, payload }) =>
		Effect.gen(function* () {
			yield* requireInternalServiceBearer(
				headers.authorization,
				(message) => new CancellationReadUnauthorizedError({ message }),
			)

			const modelName = yield* AiModel.ModelName
			return yield* readCancellation(payload, modelName).pipe(
				Effect.mapError((error) => new CancellationReadModelError({ message: error.message })),
			)
		}),
	),
)
