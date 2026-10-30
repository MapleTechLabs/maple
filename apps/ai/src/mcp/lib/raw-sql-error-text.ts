import { listWarehouseTables } from "@maple/backend/services/warehouse/warehouse-catalog"

const DB = "[A-Za-z_]\\w*"

/** The managed gateway's per-org subquery around each table, under any database name. */
const GATEWAY_WRAPPER = new RegExp(
	`(\\()?SELECT \\* FROM \\(SELECT \\* FROM ${DB}\\.(\\w+) WHERE OrgId = '[^']*'\\) AS ${DB}\\.\\w+ WHERE OrgId = '[^']*'(?:\\) AS (\\w+))?`,
	"g",
)

/**
 * A warehouse error rewritten in the caller's own terms. The managed gateway wraps every
 * table in a per-org subquery under its internal database name and our row cap wraps the
 * statement; agents copied both back into their SQL (`FROM maple_us.alert_checks`).
 */
export const rawSqlErrorText = (message: string): string => {
	const denied = message.match(/Not enough permissions for datasource '([^']+)'/)
	if (denied !== null) return `\`${denied[1]}\` cannot be read from run_sql.`
	const tables = listWarehouseTables()
		.map((t) => t.name)
		.join("|")
	return message
		.replace(GATEWAY_WRAPPER, (_whole, _open, table: string, alias: string | undefined) =>
			alias === undefined || alias === table ? table : `${table} AS ${alias}`,
		)
		.replace(new RegExp(`\\b${DB}\\.(${tables})\\b`, "g"), "$1")
		.replace(/(scope )SELECT \* FROM \(\s*/g, "$1")
		.replace(/\s*\) AS maple_raw_sql_limited\s+LIMIT \d+(?:\s+SETTINGS [\w=, ]+)?(?:\s+FORMAT \w+)?/g, "")
		.replace(/\((\w+)\.OrgId = 'org_\w+'\)/g, "$__orgFilter($1)")
		.replace(/\(OrgId = 'org_\w+'\)/g, "$__orgFilter")
		.replace(/'org_[A-Za-z0-9]+'/g, "'<your org>'")
}
