import { Schema } from "effect"
import { UnknownRecord, WidgetDataSourceTransformV2 } from "../shared/transform"

/**
 * `transform` closes the two fields v1 left as open strings
 * (`reduceToValue.aggregate`, `sortBy.direction`); `params` is still an opaque
 * bag, which v3 replaces with a discriminated union.
 */
export const WidgetDataSourceV2 = Schema.Struct({
	endpoint: Schema.String,
	params: Schema.optional(UnknownRecord),
	transform: Schema.optional(WidgetDataSourceTransformV2),
})
