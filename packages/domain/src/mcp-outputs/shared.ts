/**
 * Pieces several MCP tool outputs share. Each tool's output schema is the contract for its
 * `structuredContent`, its published `outputSchema`, and the chat UI renderer that draws it.
 */
import { Array as Arr, Record as Rec, Schema } from "effect"

/** The key that marks a tool's typed output as the chat UI's payload: `{ __maple_ui: true, tool, data }`. */
export const TOOL_UI_MARKER = "__maple_ui"

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

/** The deploy whose first span set the boundary between the windows. */
export const BoundaryDeploy = Schema.Struct({
	service: Schema.String,
	environment: Schema.String,
	commitSha: Schema.String,
	firstSeen: Schema.String,
})

/**
 * A family tool's output: the action that ran, and that action's own result. One object root, as
 * MCP asks of an output schema, where a union of the results would have none.
 */
export const familyOutput = (actions: Readonly<Record<string, Schema.Codec<unknown, unknown>>>) =>
	Schema.Struct({
		action: Schema.String.annotate({ description: `One of: ${Arr.join(Rec.keys(actions), ", ")}` }),
		result: Schema.Union(Arr.dedupe(Rec.values(actions))),
	})
