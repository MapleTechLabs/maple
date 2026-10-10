import { Array as Arr, Clock, Effect, Option, Schema, pipe } from "effect"
import * as CH from "../ch"
import { lookupByTraceId } from "./trace-lookup"
import { WarehouseExecutor } from "./WarehouseExecutor"

const StringRecordFromJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

const parseAttributes = (raw: string): Effect.Effect<Record<string, string>> =>
	Schema.decodeUnknownEffect(StringRecordFromJson)(raw).pipe(
		Effect.map((parsed) =>
			pipe(
				Object.entries(parsed),
				Arr.filter(([, v]) => v !== ""),
				Object.fromEntries,
			),
		),
		Effect.orElseSucceed(() => ({})),
	)

export interface SpanDetailInput {
	readonly traceId: string
	readonly spanId: string
	/**
	 * Approximate timestamp of the span. The hour around it is read first, which
	 * prunes the lookup to a partition or two; without it the recent days are.
	 */
	readonly timestampHint?: Date
}

export interface SpanDetailResult {
	readonly found: boolean
	readonly traceId: string
	readonly spanId: string
	/** Full span attribute map (not the trimmed set the trace tree renders). */
	readonly spanAttributes: Record<string, string>
	readonly resourceAttributes: Record<string, string>
	/** True when the hinted window missed and the lookup went on past it. */
	readonly widened?: boolean
}

/**
 * Fetch the full attribute set for one span. Complements `inspectTrace`, whose
 * tree view intentionally projects only a trimmed set of attributes per span.
 */
export const spanDetail = Effect.fn("Observability.spanDetail")(function* (input: SpanDetailInput) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan({
		orgId: executor.orgId,
		traceId: input.traceId,
		spanId: input.spanId,
	})

	const { rows, stage } = yield* lookupByTraceId({
		nowMs: yield* Clock.currentTimeMillis,
		hintMs: input.timestampHint?.getTime(),
		read: (window) =>
			executor.compiledQuery(
				CH.compile(
					CH.spanDetailQuery({
						traceId: input.traceId,
						spanId: input.spanId,
						narrowByTime: window !== undefined,
					}),
					window ? { orgId: executor.orgId, ...window } : { orgId: executor.orgId },
				),
				// The unbounded read seeks every partition; the list budget lets it finish.
				{ profile: window ? "discovery" : "list", context: "spanDetail" },
			),
	})
	// A wrong hint should not hide the span.
	const widened = input.timestampHint != null && stage !== "hint"
	const maybeRow = Arr.head(rows)
	yield* Effect.annotateCurrentSpan("widened", widened)

	if (Option.isNone(maybeRow)) {
		return {
			found: false,
			traceId: input.traceId,
			spanId: input.spanId,
			spanAttributes: {},
			resourceAttributes: {},
			widened,
		} satisfies SpanDetailResult
	}

	const row = maybeRow.value
	const spanAttributes = yield* parseAttributes(row.spanAttributes ?? "{}")
	const resourceAttributes = yield* parseAttributes(row.resourceAttributes ?? "{}")
	return {
		found: true,
		traceId: row.traceId,
		spanId: row.spanId,
		spanAttributes,
		resourceAttributes,
		widened,
	} satisfies SpanDetailResult
})
