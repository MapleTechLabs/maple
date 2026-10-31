import { listWarehouseTables } from "@maple/backend/services/warehouse/warehouse-catalog"

const DB = "[A-Za-z_]\\w*"

const INNER = `SELECT \\* FROM \\(SELECT \\* FROM ${DB}\\.(\\w+) WHERE OrgId = '[^']*'\\) AS ${DB}\\.\\w+ WHERE OrgId = '[^']*'`

/** The managed gateway's per-org subquery around a table, as `(...) AS alias` or bare. */
const ALIASED_WRAPPER = new RegExp(`\\(${INNER}\\) AS (\\w+)`, "g")
const BARE_WRAPPER = new RegExp(INNER, "g")

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
		.replace(ALIASED_WRAPPER, (_whole, table: string, alias: string) =>
			alias === table ? table : `${table} AS ${alias}`,
		)
		.replace(BARE_WRAPPER, "$1")
		.replace(new RegExp(`\\b${DB}\\.(${tables})\\b`, "g"), "$1")
		.replace(/(scope )SELECT \* FROM \(\s*/g, "$1")
		.replace(/\s*\) AS maple_raw_sql_limited\s+LIMIT \d+(?:\s+SETTINGS [\w=, ]+)?(?:\s+FORMAT \w+)?/g, "")
		.replace(/\((\w+)\.OrgId = 'org_\w+'\)/g, "$__orgFilter($1)")
		.replace(/\(OrgId = 'org_\w+'\)/g, "$__orgFilter")
		.replace(/'org_[A-Za-z0-9]+'/g, "'<your org>'")
}
