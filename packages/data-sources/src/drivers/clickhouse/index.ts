import { registerDriver } from "../../port"
import { clickHouseCatalog } from "./catalog"
import { validateClickHouseConnection } from "./connection"
import { prepareClickHouse } from "./run"
import { testClickHouse } from "./test-connection"

/** An org's own ClickHouse over its HTTP interface. Every request runs with `readonly=1`. */
export const clickHouseDriver = registerDriver<"clickhouse">({
	kind: "clickhouse",
	queryLanguage: "sql:clickhouse",
	validateConnection: validateClickHouseConnection,
	test: (connection) => testClickHouse(connection),
	catalog: (connection) => clickHouseCatalog(connection),
	prepare: prepareClickHouse,
})

export { clickHouseSqlIssue, CLICKHOUSE_MACROS } from "./sql"
