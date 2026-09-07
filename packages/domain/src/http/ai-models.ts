import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { SessionAuthorization } from "./current-tenant"

// AI model detection: a model string as an instrumentation reported it
// (`gen_ai.request.model`, an OpenRouter id, a Bedrock id) → the model's
// vendor and display name. Resolved by `@maple/ai-model-catalog`; the icon
// is the dashboard's to pick from `vendorSlug` / `family`, so it never
// crosses the wire.

export class DetectAiModelRequest extends Schema.Class<DetectAiModelRequest>("DetectAiModelRequest")({
	/** Bounded because it is matched against a catalog, never stored — nothing legitimate is longer. */
	model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
}) {}

export const AiModelDetectionSource = Schema.Literals(["openrouter", "heuristic", "unknown"])
export type AiModelDetectionSource = Schema.Schema.Type<typeof AiModelDetectionSource>

export class DetectAiModelResponse extends Schema.Class<DetectAiModelResponse>("DetectAiModelResponse")({
	/** The input, trimmed. */
	model: Schema.String,
	/** The model segment, lowercased, variant kept: `glm-5.3-flash:nitro`. */
	slug: Schema.String,
	/** Variant, date stamp and gateway decoration removed: `glm-5.3-flash`. */
	normalizedSlug: Schema.String,
	/** `z-ai/glm-5.3-flash` when OpenRouter lists the model. */
	openRouterId: Schema.NullOr(Schema.String),
	/** `GLM 5.3 Flash` */
	displayName: Schema.String,
	/** `z-ai` — the key the dashboard resolves an icon from. */
	vendorSlug: Schema.NullOr(Schema.String),
	/** `Z.ai` */
	vendorName: Schema.NullOr(Schema.String),
	/** A product family with a mark of its own (`claude`, `gemini`, `grok`, `llama`, `kimi`). */
	family: Schema.NullOr(Schema.String),
	source: AiModelDetectionSource,
}) {}

export class AiModelsInternalApiGroup extends HttpApiGroup.make("aiModelsInternal")
	.add(
		HttpApiEndpoint.post("detect", "/detect", {
			payload: DetectAiModelRequest,
			success: DetectAiModelResponse,
		}),
	)
	.prefix("/internal/ai-models")
	.middleware(SessionAuthorization) {}
