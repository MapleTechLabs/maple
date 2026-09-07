import { HttpApiBuilder } from "effect/unstable/httpapi"
import { detectAiModel } from "@maple/ai-model-catalog"
import { DetectAiModelResponse, MapleInternalApi } from "@maple/domain/http"
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
		handlers.handle("detect", ({ payload }) =>
			Effect.sync(() => new DetectAiModelResponse(detectAiModel(payload.model))),
		),
)
