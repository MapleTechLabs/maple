/**
 * The port the review's feedback filter embeds finding text through. The model behind it is wired
 * in `apps/ai/src/platform/Llm.ts`; where it is absent the filter is off and every finding posts.
 */
import { Context, type Effect, Layer, Option, Schema } from "effect"

export class PrReviewEmbeddingError extends Schema.TaggedError<PrReviewEmbeddingError>()(
	"@maple/backend/services/pr-review/PrReviewEmbeddingError",
	{
		message: Schema.String,
		model: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export interface FindingEmbedderApi {
	/** Stored beside each vector: vectors from two models are never compared. */
	readonly model: string
	/** One vector per input, in input order. */
	readonly embed: (
		inputs: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, PrReviewEmbeddingError>
}

/** The embedder, or none where no model is configured: then the feedback filter is off. */
export class FindingEmbedder extends Context.Service<FindingEmbedder, Option.Option<FindingEmbedderApi>>()(
	"@maple/backend/services/pr-review/FindingEmbedder",
) {
	static readonly none = Layer.succeed(this, Option.none())
}
