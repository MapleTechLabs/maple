// Adapter between this process and the local Maple binary's `/local/query`
// endpoint, which runs raw SQL through the in-process chDB session and returns
// a bare JSON array. Mirrors the browser client in
// apps/local-ui/src/lib/local-query-client.ts, but takes an explicit base URL
// so the CLI / HTTP server can target the absolute ingest address (the SPA
// version uses a relative URL behind its vite proxy).
//
// Gotcha: `CH.compile(...)` appends `FORMAT JSON`, but the Rust handler runs the
// SQL verbatim and expects the rows back as `FORMAT JSONEachRow`. Strip whatever
// trailing FORMAT the compiler added and re-append `FORMAT JSONEachRow`.

/** Strip a trailing `FORMAT <fmt>` clause (optionally followed by `;`). */
function stripTrailingFormat(sql: string): string {
	return sql.replace(/\s+FORMAT\s+\w+\s*;?\s*$/i, "")
}

export async function executeLocalQuery<T = Record<string, unknown>>(
	baseUrl: string,
	sql: string,
): Promise<T[]> {
	const normalized = `${stripTrailingFormat(sql)}\nFORMAT JSONEachRow`

	const res = await fetch(`${baseUrl}/local/query`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sql: normalized }),
	})

	if (!res.ok) {
		const detail = await res.text().catch(() => "")
		throw new Error(
			`Local query failed (${res.status} ${res.statusText})${detail ? `: ${detail}` : ""}`,
		)
	}

	const json = (await res.json()) as unknown
	if (!Array.isArray(json)) {
		throw new Error("Local query response was not a JSON array")
	}
	return json as T[]
}
