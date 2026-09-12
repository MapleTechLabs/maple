import { Effect } from "effect"
import { WarehouseDriverError } from "@maple/query-engine/execution"
import { __testables } from "@/services/warehouse/WarehouseQueryService"
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
 */
export const installFakeWarehouse = (rules: FixtureRule[] = defaultTraceFixtures()): void => {
	__testables.setClientFactory(() =>
		Effect.succeed({
			sql: (statement) =>
				Effect.suspend(() => {
					const sql = statement.text
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

/**
 * One rule whose rule set can be swapped per test.
 *
 * The warehouse client is built once with the layer, so the fake is installed
 * once and cannot be re-installed for a single case — `withRules` changes what
 * the installed rule consults underneath, which is what makes an empty-read
 * (empty state, no matching rows) test possible.
 */
export const swappableFixtures = (base: FixtureRule[]) => {
	let rules = base
	let matchedRows: ReadonlyArray<unknown> = []
	const rule: FixtureRule = {
		match: (sql) => {
			const matched = rules.find((candidate) => candidate.match(sql))
			matchedRows = matched === undefined ? [] : matched.rows
			return matched !== undefined
		},
		// Read only after `match` answered true, so these are that rule's rows.
		get rows() {
			return matchedRows
		},
	}
	return {
		rule,
		/** Run `body` against a narrower rule set — an empty read, usually. */
		withRules: async <A>(temporary: FixtureRule[], body: () => Promise<A>): Promise<A> => {
			rules = temporary
			try {
				return await body()
			} finally {
				rules = base
			}
		},
	}
}
