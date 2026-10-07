/**
 * `POST /internal/cancellation/assess` — the decision model's read of a
 * cancelling org's usage, for the api Worker's cancellation consumer. Same
 * caller identity as triage: the internal service token, no tenant.
 */
import {
	CancellationAssessmentModelError,
	IncidentTriageUnauthorizedError,
	MapleAiApi,
} from "@maple/domain/http"
import { Effect, Option, Redacted } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Env } from "@maple/backend/platform/Env"
import { assessCancellation } from "../../cancellation/assess"
import { loadLlmSettings, resolveDecisionModel } from "../../platform/Llm"
import { isValidServiceBearer } from "./triage.http"

export const HttpCancellationLive = HttpApiBuilder.group(MapleAiApi, "cancellation", (handlers) =>
	handlers.handle("assess", ({ headers, payload }) =>
		Effect.gen(function* () {
			const config = yield* Env
			const expected = Option.map(config.INTERNAL_SERVICE_TOKEN, Redacted.value)
			if (Option.isNone(expected) || !isValidServiceBearer(headers.authorization, expected.value)) {
				return yield* new IncidentTriageUnauthorizedError({
					message: "internal service token rejected",
				})
			}

			const model = resolveDecisionModel(yield* loadLlmSettings)
			if (model === undefined) {
				return yield* new CancellationAssessmentModelError({
					message: "no decision model is served in this region",
				})
			}
			return yield* assessCancellation({ snapshot: payload, model }).pipe(
				Effect.mapError((error) => new CancellationAssessmentModelError({ message: error.message })),
			)
		}),
	),
)
