/**
 * Pieces several MCP tool outputs share. Each tool's output schema is the contract for its
 * `structuredContent`, its published `outputSchema`, and the chat UI renderer that draws it.
 */
import { Schema } from "effect"

/** The resolved window a result covers, as `YYYY-MM-DD HH:mm:ss` UTC. */
export const OutputTimeRange = Schema.Struct({ start: Schema.String, end: Schema.String })

/** A page of a longer result. `nextOffset` is set while more rows remain. */
export const OutputPagination = Schema.Struct({
	offset: Schema.Number,
	limit: Schema.Number,
	hasMore: Schema.Boolean,
	total: Schema.optionalKey(Schema.Number),
	nextOffset: Schema.optionalKey(Schema.Number),
})
