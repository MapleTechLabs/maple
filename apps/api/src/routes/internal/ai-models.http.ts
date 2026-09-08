import { HttpApiBuilder } from "effect/unstable/httpapi"
import { detectAiModel } from "@maple/ai-model-catalog"
import { CurrentTenant, DetectAiModelResponse, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"

/**
 * Model string → vendor and display name, for the Agent Sessions surfaces.
 * Pure catalog lookup, no tenant data; session-authorized only because
 * nothing under `/internal` is public.
 */
export const HttpAiModelsInternalLive = HttpApiBuilder.group(
	MapleInternalApi,
	"aiModelsInternal",
	(handlers) =>
		handlers
			.handle("detect", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const detected = detectAiModel(payload.model)
					// Attributes on the server span, never a child span: this is one call
					// per model string on a list page. `source: unknown` is the signal that
					// the catalog wants regenerating.
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.ai_model.source": detected.source,
						"maple.ai_model.vendor_slug": detected.vendorSlug ?? "",
					})
					return new DetectAiModelResponse(detected)
				}),
			)
			.handle("detectMany", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const detected = payload.models.map(
						(model) => new DetectAiModelResponse(detectAiModel(model)),
					)
					// The batch's shape rather than each model's: an unresolved count
					// climbing is the same signal `source: unknown` is on the single
					// endpoint, and it stays one attribute however long the batch is.
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						"maple.ai_model.count": detected.length,
						"maple.ai_model.unknown_count": detected.filter((model) => model.source === "unknown")
							.length,
					})
					return detected
				}),
			),
)
