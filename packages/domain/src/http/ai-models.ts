import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { SessionAuthorization } from "./current-tenant"

// AI model detection: a model string as an instrumentation reported it
// (`gen_ai.request.model`, an OpenRouter id, a Bedrock id) → the model's
// vendor and display name. Resolved by `@maple/ai-model-catalog`; the icon
// is the dashboard's to pick from `vendorSlug` / `family`, so it never
// crosses the wire. The vendor's brand color does: it is catalog data, and
// the dashboard keeps no catalog of its own.

/** Trimmed, then bounded: matched against a catalog, never stored — nothing legitimate is longer. */
const ModelString = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500))

export class DetectAiModelRequest extends Schema.Class<DetectAiModelRequest>("DetectAiModelRequest")({
	model: ModelString,
}) {}

export class DetectAiModelsRequest extends Schema.Class<DetectAiModelsRequest>("DetectAiModelsRequest")({
	/**
	 * The distinct model strings a page needs to render, deduped by the caller.
	 * Bounded because a page that needs more than this many marks has stopped
	 * being a page; the sessions list pages 50 rows at a time.
	 */
	models: Schema.Array(ModelString).check(Schema.isMaxLength(200)),
}) {}

export const AiModelDetectionSource = Schema.Literals(["openrouter", "heuristic", "unknown"])
export type AiModelDetectionSource = Schema.Schema.Type<typeof AiModelDetectionSource>

/** A brand's color on the light canvas and on the dark one, each holding 3:1 there. */
export const AiModelBrandColor = Schema.Struct({
	light: Schema.String,
	dark: Schema.String,
})

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
	/** The vendor's brand color, when the catalog lists one. */
	brandColor: Schema.NullOr(AiModelBrandColor),
	/** A product family with a mark of its own (`claude`, `gemini`, `grok`, `kimi`). */
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
	.add(
		// One request per page rather than one per model: the sessions list would
		// otherwise open a connection per distinct model in the viewport.
		// Results come back in request order, so the caller can zip them.
		HttpApiEndpoint.post("detectMany", "/detect-many", {
			payload: DetectAiModelsRequest,
			success: Schema.Array(DetectAiModelResponse),
		}),
	)
	.prefix("/internal/ai-models")
	.middleware(SessionAuthorization) {}
