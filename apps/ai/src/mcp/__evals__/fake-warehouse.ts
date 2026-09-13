import { Effect } from "effect"
import { WarehouseDriverError, WarehouseResponseLimitError } from "@maple/query-engine/execution"
import { __testables } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeLargeTraceSpans, makeTraceLogs } from "./fixtures"

export interface FixtureRule {
	/** Match against the compiled SQL the WarehouseQueryService would execute. */
	readonly match: (sql: string) => boolean
	readonly rows: ReadonlyArray<unknown>
}

/**
 * Default fixtures for the large-trace `inspect_trace` scenario. Both the
 * `span_hierarchy` and `list_logs` pipes compile to SQL referencing their CH
 * table, so we route by table name.
 */
const defaultTraceFixtures = (): FixtureRule[] => [
	{ match: (sql) => sql.includes("trace_detail_spans"), rows: makeLargeTraceSpans() },
	{ match: (sql) => /\bfrom\s+logs\b/i.test(sql), rows: makeTraceLogs() },
]

/**
 * Replace the warehouse SQL client with a fake that answers from fixtures. The
 * REAL WarehouseQueryService still runs (OrgId enforcement, CH-DSL compile,
 * pipe-dispatch, row parsing) — only the wire call is faked. Unmatched SQL
 * throws loudly so missing fixtures never look like an empty result.
 *
 * The client is built once with the layer and cannot be re-installed for a
 * single case, but `rules` is consulted on every call: a test that holds the
 * array can change what one case answers with by changing its contents.
 */
export const installFakeWarehouse = (
	rules: FixtureRule[] = defaultTraceFixtures(),
	/** SQL the warehouse aborts on rather than answering with rows. The client is
	 *  cached for the runtime's lifetime, so a test switches the failure from
	 *  inside this hook rather than by re-installing. */
	failWhen?: (sql: string) => boolean,
): void => {
	__testables.setClientFactory(() =>
		Effect.succeed({
			sql: (statement) =>
				Effect.suspend((): Effect.Effect<
					{ data: ReadonlyArray<Record<string, unknown>> },
					WarehouseDriverError | WarehouseResponseLimitError
				> => {
					const sql = statement.text
					if (failWhen?.(sql) === true) {
						return Effect.fail(
							new WarehouseResponseLimitError({
								kind: "bytes",
								message: "response exceeded the byte limit",
							}),
						)
					}
					const rule = rules.find((r) => r.match(sql))
					if (!rule) {
						return Effect.fail(
							new WarehouseDriverError({
								reason: "unknown",
								message: `[eval fake warehouse] no fixture matched SQL:\n${sql.slice(0, 600)}`,
							}),
						)
					}
					return Effect.succeed({ data: rule.rows as ReadonlyArray<Record<string, unknown>> })
				}),
			insert: () => Effect.void,
		}),
	)
}

export const restoreWarehouse = (): void => __testables.reset()
