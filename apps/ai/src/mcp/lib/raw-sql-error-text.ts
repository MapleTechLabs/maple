import { listWarehouseTables } from "@maple/backend/services/warehouse/warehouse-catalog"
import { Array as Arr, Option, String as Str } from "effect"
import { replaceWith } from "@maple/strings"

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
	const denied = Str.match(/Not enough permissions for datasource '([^']+)'/)(message)
	if (Option.isSome(denied)) return `\`${denied.value[1]}\` cannot be read from run_sql.`
	const tables = Arr.join(
		Arr.map(listWarehouseTables(), (t) => t.name),
		"|",
	)
	return Str.replace(
		/'org_[A-Za-z0-9]+'/g,
		"'<your org>'",
	)(
		Str.replace(
			/\(OrgId = 'org_\w+'\)/g,
			"$__orgFilter",
		)(
			Str.replace(
				/\((\w+)\.OrgId = 'org_\w+'\)/g,
				"$__orgFilter($1)",
			)(
				Str.replace(
					/\s*\) AS maple_raw_sql_limited\s+LIMIT \d+(?:\s+SETTINGS [\w=, ]+)?(?:\s+FORMAT \w+)?/g,
					"",
				)(
					Str.replace(
						/(scope )SELECT \* FROM \(\s*/g,
						"$1",
					)(
						Str.replace(
							new RegExp(`\\b${DB}\\.(${tables})\\b`, "g"),
							"$1",
						)(
							Str.replace(
								BARE_WRAPPER,
								"$1",
							)(
								replaceWith(message, ALIASED_WRAPPER, (_whole, table = "", alias = "") =>
									alias === table ? table : `${table} AS ${alias}`,
								),
							),
						),
					),
				),
			),
		),
	)
}
