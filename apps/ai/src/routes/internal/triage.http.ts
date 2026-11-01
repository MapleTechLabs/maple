/**
 * `POST /internal/triage/classify` — the decision model, as a service.
 *
 * The Workers that open incidents (alerting's ticks, api's alert path) have no
 * model key and no decision layer; maple-ai has both. They ask here, over a
 * service binding, before spending an investigation's pass. The caller is a
 * cron tick with no tenant of its own, so the internal service token is the
 * whole identity, and nothing of the org's is read or written on this path.
 */
import { IncidentTriageModelError, IncidentTriageUnauthorizedError, MapleAiApi } from "@maple/domain/http"
import { Effect, Option, Redacted } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Env } from "@maple/backend/platform/Env"
import { loadLlmSettings, resolveDecisionModel } from "../../platform/Llm"
import { classifyIncident } from "../../triage/incident-classifier"
import { isValidServiceBearer } from "./service-bearer"

export const HttpTriageLive = HttpApiBuilder.group(MapleAiApi, "triage", (handlers) =>
	handlers.handle("classify", ({ headers, payload }) =>
		Effect.gen(function* () {
			const config = yield* Env
			const expected = Option.map(config.INTERNAL_SERVICE_TOKEN, Redacted.value)
			if (Option.isNone(expected)) {
				return yield* new IncidentTriageUnauthorizedError({
					message: "INTERNAL_SERVICE_TOKEN is not configured on maple-ai",
				})
			}
			if (!isValidServiceBearer(headers.authorization, expected.value)) {
				return yield* new IncidentTriageUnauthorizedError({
					message: "internal service token rejected",
				})
			}

			const model = resolveDecisionModel(yield* loadLlmSettings)
			if (model === undefined) {
				return yield* new IncidentTriageModelError({
					message: "no decision model is served in this region",
				})
			}
			return yield* classifyIncident({ request: payload, model }).pipe(
				Effect.mapError((error) => new IncidentTriageModelError({ message: error.message })),
			)
		}),
	),
)
