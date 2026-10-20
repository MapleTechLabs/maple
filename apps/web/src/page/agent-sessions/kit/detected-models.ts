import { AiModelBrandColor, DetectAiModelsRequest } from "@maple/domain/http"
import { shortTarget } from "../../../lib/agent-sessions/span-filters"
import { Effect, Option, Record, Schema } from "effect"
import { MapleInternalApiClient } from "../../../platform/api-clients"

// Model detection: one `detectMany` per distinct
// sorted model set a call site renders, deduped across the page, answers kept for the page's life.

/** What a model string resolved to; the same shape whether the catalog answered or not. */
export const DetectedModel = Schema.Struct({
	model: Schema.String,
	displayName: Schema.String,
	vendorSlug: Schema.NullOr(Schema.String),
	vendorName: Schema.NullOr(Schema.String),
	brandColor: Schema.NullOr(AiModelBrandColor),
	family: Schema.NullOr(Schema.String),
})
export type DetectedModel = typeof DetectedModel.Type

/** Answers by request key; a key present with `null` is in flight (or failed: models stay unresolved). */
export const Detections = Schema.Record(Schema.String, Schema.NullOr(Schema.Array(DetectedModel)))
export type Detections = typeof Detections.Type

const unresolved = (model: string): DetectedModel => ({
	model,
	displayName: shortTarget(model),
	vendorSlug: null,
	vendorName: null,
	brandColor: null,
	family: null,
})

/** The endpoint's cap, mirrored so a long page degrades to unresolved names instead of a 400. */
const MAX_MODELS = 200

/** One request per distinct set: sorted so two orders of the same models share the key. */
export const detectionKey = (models: ReadonlyArray<string>): string =>
	JSON.stringify([...new Set(models)].toSorted().slice(0, MAX_MODELS))

/** `Some(key)` when the set has not been asked for yet. */
export const missingDetection = (
	detections: Detections,
	models: ReadonlyArray<string>,
): Option.Option<string> => {
	const key = detectionKey(models)
	return Record.has(detections, key) ? Option.none() : Option.some(key)
}

/** Every answer so far, as one lookup; an unanswered model renders its last path segment. */
export const detectLookup = (detections: Detections) => {
	const byModel = new Map(
		Object.values(detections).flatMap((answer) =>
			(answer ?? []).map((entry) => [entry.model, entry] as const),
		),
	)
	return (model: string): DetectedModel => byModel.get(model.trim()) ?? unresolved(model)
}

/** `modelTitle`: the vendor, then the id it was reported under. */
export const modelTitle = (detected: DetectedModel): string =>
	detected.vendorName === null ? detected.model : `${detected.vendorName} · ${detected.model}`

const decodeModels = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

/** The batch for one key; a failure leaves the models unresolved, like the atom's `orElse`. */
export const detectModels = (key: string) =>
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		const models = Option.getOrElse(decodeModels(key), () => [])
		const response = yield* client.aiModelsInternal.detectMany({
			payload: new DetectAiModelsRequest({ models }),
		})
		return response.map((entry): DetectedModel => ({
			model: entry.model,
			displayName: entry.displayName,
			vendorSlug: entry.vendorSlug,
			vendorName: entry.vendorName,
			brandColor: entry.brandColor,
			family: entry.family,
		}))
	}).pipe(Effect.orElseSucceed((): ReadonlyArray<DetectedModel> => []))
