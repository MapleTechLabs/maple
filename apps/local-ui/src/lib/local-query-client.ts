// Single adapter between the browser and the local Rust binary's `/local/query`
// endpoint. The endpoint runs raw SQL through the in-process chDB session and
// returns a bare JSON array.
//
// Gotcha: `CH.compile(...)` appends `FORMAT JSON` to the SQL, but the Rust
// handler does NOT add a FORMAT clause — it runs the SQL verbatim and expects
// the rows to come back as `FORMAT JSONEachRow` (one JSON object per line, which
// chDB emits as a JSON array via the handler). So we strip whatever trailing
// FORMAT the compiler added and re-append `FORMAT JSONEachRow`.

const LOCAL_QUERY_ENDPOINT = "/local/query"

/** Strip a trailing `FORMAT <fmt>` clause (optionally followed by `;`). */
function stripTrailingFormat(sql: string): string {
	return sql.replace(/\s+FORMAT\s+\w+\s*;?\s*$/i, "")
}

export async function executeLocalQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
	const normalized = `${stripTrailingFormat(sql)}\nFORMAT JSONEachRow`

	const res = await fetch(LOCAL_QUERY_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sql: normalized }),
	})

	if (!res.ok) {
		const detail = await res.text().catch(() => "")
		throw new Error(`Local query failed (${res.status} ${res.statusText})${detail ? `: ${detail}` : ""}`)
	}

	const json = (await res.json()) as unknown
	if (!Array.isArray(json)) {
		throw new Error("Local query response was not a JSON array")
	}
	return json as T[]
}
