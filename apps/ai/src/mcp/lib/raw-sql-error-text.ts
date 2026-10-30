/**
 * A warehouse error rewritten in the caller's own terms. The managed gateway wraps every
 * table in a per-org subquery under its internal database name and our row cap wraps the
 * statement; agents copied both back into their SQL (`FROM maple_us.alert_checks`).
 */
export const rawSqlErrorText = (message: string): string => {
	const denied = message.match(/Not enough permissions for datasource '([^']+)'/)
	if (denied !== null) return `\`${denied[1]}\` cannot be read from run_sql.`
	return message
		.replace(
			/\(SELECT \* FROM \(SELECT \* FROM maple_[a-z]+\.(\w+) WHERE OrgId = '[^']*'\) AS maple_[a-z]+\.\w+ WHERE OrgId = '[^']*'\) AS \w+/g,
			"$1",
		)
		.replace(
			/SELECT \* FROM \(SELECT \* FROM maple_[a-z]+\.(\w+) WHERE OrgId = '[^']*'\) AS maple_[a-z]+\.\w+ WHERE OrgId = '[^']*'/g,
			"$1",
		)
		.replace(/\bmaple_(?:us|eu)\./g, "")
		.replace(/(scope )SELECT \* FROM \(\s*/g, "$1")
		.replace(/\s*\) AS maple_raw_sql_limited\s+LIMIT \d+(?:\s+SETTINGS [\w=, ]+)?(?:\s+FORMAT \w+)?/g, "")
		.replace(/\((\w+)\.OrgId = 'org_\w+'\)/g, "$__orgFilter($1)")
		.replace(/\(OrgId = 'org_\w+'\)/g, "$__orgFilter")
}
