/**
 * Dependency-free ClickHouse HTTP client mirroring `execClickHouse` in
 * `apps/api/src/workflows/ClickHouseSchemaApplyWorkflow.run.ts`. No Effect here: it would balloon
 * the install footprint of `bunx @maple/clickhouse-cli`.
 */

export interface ClickHouseConfig {
	readonly url: string
	readonly user: string
	readonly password: string
	readonly database: string
}

/**
 * `database` goes in both the header and `?database=`: CH Cloud's 24.x analyzer sometimes fails
 * to resolve unqualified table names in MV bodies with only the header (`Code: 60. UNKNOWN_TABLE`).
 */
export async function exec(config: ClickHouseConfig, sql: string): Promise<string> {
	const url = `${config.url.replace(/\/$/, "")}/?database=${encodeURIComponent(config.database)}`
	const headers = new Headers({
		"Content-Type": "text/plain",
		"X-ClickHouse-User": config.user,
		"X-ClickHouse-Database": config.database,
	})
	if (config.password.length > 0) {
		headers.set("X-ClickHouse-Key", config.password)
	}
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: sql,
	})
	const body = await response.text()
	if (!response.ok) {
		throw new ClickHouseError(response.status, body)
	}
	return body
}

// This dependency-free Promise client throws across its CLI boundary; it never enters an Effect error channel.
// oxlint-disable-next-line effecttsgo/extends-native-error
export class ClickHouseError extends Error {
	readonly status: number
	readonly body: string
	constructor(status: number, body: string) {
		// Trim ClickHouse's stack-trace verbosity to one line for the headline.
		const headline = body.split("\n")[0]?.slice(0, 500) ?? ""
		super(`ClickHouse ${status}: ${headline}`)
		this.name = "ClickHouseError"
		this.status = status
		this.body = body
	}
}

export async function ping(config: ClickHouseConfig): Promise<string> {
	const text = await exec(config, "SELECT version() FORMAT TabSeparated")
	return text.trim()
}
