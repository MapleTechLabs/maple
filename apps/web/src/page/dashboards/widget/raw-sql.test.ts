import { describe, expect, it } from "vitest"
import { isRunnableSql, type RawSqlState } from "./raw-sql"

const UNBOUNDED = "SELECT count() AS value FROM logs WHERE $__orgFilter"
const BOUNDED = "SELECT count() AS value FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)"

const stateOf = (initial: string, draft: string): RawSqlState => ({
	draft: { sql: draft, granularitySeconds: null },
	staged: { sql: draft, granularitySeconds: null },
	initial: { sql: initial, granularitySeconds: null },
	isCollapsed: false,
})

describe("isRunnableSql", () => {
	it("keeps a widget saved without a time filter runnable while its SQL is untouched", () => {
		expect(isRunnableSql(stateOf(UNBOUNDED, UNBOUNDED))).toBe(true)
	})

	it("requires a time filter once the SQL is edited", () => {
		expect(isRunnableSql(stateOf(UNBOUNDED, `${UNBOUNDED} AND ServiceName = 'api'`))).toBe(false)
		expect(isRunnableSql(stateOf(UNBOUNDED, BOUNDED))).toBe(true)
	})
})
