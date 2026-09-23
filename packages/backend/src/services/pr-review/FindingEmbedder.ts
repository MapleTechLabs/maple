/**
 * The port the review's feedback filter embeds finding text through. The model behind it is wired
 * in `apps/ai/src/platform/Llm.ts`; where it is absent the filter is off and every finding posts.
 */
import { Context, type Effect, Schema } from "effect"

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

export class FindingEmbedder extends Context.Service<FindingEmbedder, FindingEmbedderApi>()(
	"@maple/backend/services/pr-review/FindingEmbedder",
) {}
