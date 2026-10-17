import type { Dataset, SyncedTableName, SyncedRow } from "../fixtures/dataset.ts"

/**
 * Stands in for `apps/electric-sync` (`GET /api/sync/shape?shape=<name>&org=...`) and, for
 * tools that talk to Electric directly, `GET /v1/shape?table=<table>`. Implements just enough of
 * the protocol for the client to reach up-to-date:
 *
 * - initial request (`offset=-1`): every row as an insert, then an up-to-date control message
 * - live request (`live=true`): up-to-date after ~150 ms; holding it open would exhaust the
 *   browser's six-connections-per-origin pool and starve the API
 *
 * Values are Postgres text, typed by the `electric-schema` header, as the real server sends them.
 */

type PgType = "text" | "bool" | "int4" | "float8" | "jsonb" | "timestamptz"

interface SyncedTableSpec {
	readonly table: string
	readonly key: ReadonlyArray<string>
	readonly columns: Readonly<Record<string, PgType>>
}

const ts = "timestamptz" as const

/** Column types per shape, from `packages/db/src/tables/` and `apps/electric-sync`'s registry. */
export const SYNCED_TABLES = {
	api_keys: {
		table: "api_keys",
		key: ["id"],
		columns: {
			id: "text",
			org_id: "text",
			name: "text",
			description: "text",
			key_prefix: "text",
			revoked: "bool",
			revoked_at: ts,
			last_used_at: ts,
			expires_at: ts,
			scopes: "jsonb",
			kind: "text",
			created_at: ts,
			created_by: "text",
			created_by_email: "text",
		},
	},
	dashboards: {
		table: "dashboards",
		key: ["org_id", "id"],
		columns: {
			org_id: "text",
			id: "text",
			name: "text",
			payload_json: "jsonb",
			created_at: ts,
			updated_at: ts,
			created_by: "text",
			updated_by: "text",
			version: "int4",
		},
	},
	alert_rules: {
		table: "alert_rules",
		key: ["id"],
		columns: {
			id: "text",
			org_id: "text",
			name: "text",
			notes: "text",
			notification_template_json: "jsonb",
			enabled: "bool",
			severity: "text",
			service_names_json: "jsonb",
			exclude_service_names_json: "jsonb",
			environments_json: "jsonb",
			tags_json: "jsonb",
			signal_type: "text",
			comparator: "text",
			threshold: "float8",
			threshold_upper: "float8",
			window_minutes: "int4",
			minimum_sample_count: "int4",
			consecutive_breaches_required: "int4",
			consecutive_healthy_required: "int4",
			renotify_interval_minutes: "int4",
			apdex_threshold_ms: "float8",
			query_builder_draft_json: "jsonb",
			raw_query_sql: "text",
			reducer: "text",
			group_by: "text",
			destination_ids_json: "jsonb",
			query_spec_json: "jsonb",
			sample_count_strategy: "text",
			no_data_behavior: "text",
			last_scheduled_at: ts,
			created_at: ts,
			updated_at: ts,
			created_by: "text",
			updated_by: "text",
		},
	},
	alert_rule_states: {
		table: "alert_rule_states",
		key: ["org_id", "rule_id", "group_key"],
		columns: {
			org_id: "text",
			rule_id: "text",
			group_key: "text",
			consecutive_breaches: "int4",
			consecutive_healthy: "int4",
			last_status: "text",
			last_value: "float8",
			last_sample_count: "int4",
			last_evaluated_at: ts,
			last_error: "text",
			updated_at: ts,
		},
	},
	alert_incidents: {
		table: "alert_incidents",
		key: ["id"],
		columns: {
			id: "text",
			org_id: "text",
			rule_id: "text",
			incident_key: "text",
			rule_name: "text",
			group_key: "text",
			signal_type: "text",
			severity: "text",
			status: "text",
			comparator: "text",
			threshold: "float8",
			threshold_upper: "float8",
			first_triggered_at: ts,
			last_triggered_at: ts,
			resolved_at: ts,
			last_observed_value: "float8",
			last_sample_count: "int4",
			last_evaluated_at: ts,
			dedupe_key: "text",
			last_delivered_event_type: "text",
			last_notified_at: ts,
			hold_reason: "text",
			held_since: ts,
			error_issue_id: "text",
			created_at: ts,
			updated_at: ts,
		},
	},
	alert_destinations: {
		table: "alert_destinations",
		key: ["id"],
		columns: {
			id: "text",
			org_id: "text",
			name: "text",
			type: "text",
			enabled: "bool",
			config_json: "jsonb",
			last_tested_at: ts,
			last_test_error: "text",
			created_at: ts,
			updated_at: ts,
		},
	},
	alert_destinations_v2: {
		table: "alert_destinations",
		key: ["id"],
		columns: {
			id: "text",
			org_id: "text",
			name: "text",
			type: "text",
			enabled: "bool",
			config_json: "jsonb",
			last_tested_at: ts,
			last_test_error: "text",
			disabled_at: ts,
			disabled_reason: "text",
			created_at: ts,
			updated_at: ts,
		},
	},
	investigation_v2: {
		table: "investigations",
		key: ["id"],
		columns: {
			id: "text",
			org_id: "text",
			status: "text",
			seeded_by: "text",
			subject_json: "jsonb",
			snapshot_json: "jsonb",
			report_json: "jsonb",
			progress_json: "jsonb",
			severity: "text",
			confidence: "text",
			model: "text",
			input_tokens: "int4",
			output_tokens: "int4",
			error: "text",
			created_by: "text",
			created_at: ts,
			started_at: ts,
			diagnosed_at: ts,
			updated_at: ts,
		},
	},
} satisfies Readonly<Record<SyncedTableName, SyncedTableSpec>>

const SYNCED_TABLE_NAMES: ReadonlyArray<SyncedTableName> = [
	"api_keys",
	"dashboards",
	"alert_rules",
	"alert_rule_states",
	"alert_incidents",
	"alert_destinations",
	"alert_destinations_v2",
	"investigation_v2",
]

/** `?shape=` (the sync proxy the browser calls) or `?table=` (Electric itself). */
const syncedTableOf = (url: URL): SyncedTableName | undefined => {
	const requested = url.searchParams.get("shape")
	const table = url.searchParams.get("table")
	return SYNCED_TABLE_NAMES.find((name) =>
		requested === null ? SYNCED_TABLES[name].table === table : name === requested,
	)
}

const encodeValue = (type: PgType, value: unknown): string | null => {
	if (value === null || value === undefined) return null
	if (type === "jsonb") return JSON.stringify(value)
	if (type === "timestamptz" && typeof value === "number") return new Date(value).toISOString()
	return String(value)
}

const UP_TO_DATE = { headers: { control: "up-to-date", global_last_seen_lsn: "0" } }
export const LIVE_POLL_DELAY_MS = 150

const encodeRows = (synced: SyncedTableName, rows: ReadonlyArray<SyncedRow>, scope: string | null) => {
	const spec = SYNCED_TABLES[synced]
	const columns = Object.entries(spec.columns)
	// The proxy filters investigations by `scope` (`"id" = $2`); every shape is already one org's rows.
	const visible = scope === null ? rows : rows.filter((row) => row.id === scope)
	return visible.map((row) => ({
		key: `"public"."${spec.table}"/${spec.key.map((column) => `"${String(row[column])}"`).join("/")}`,
		value: Object.fromEntries(columns.map(([column, type]) => [column, encodeValue(type, row[column])])),
		headers: { operation: "insert", relation: ["public", spec.table] },
	}))
}

export const electricCorsHeaders = (request: Request): Record<string, string> => ({
	"access-control-allow-origin": request.headers.get("origin") ?? "*",
	"access-control-allow-credentials": "true",
	"access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "*",
	"access-control-allow-methods": "GET, OPTIONS",
	"access-control-expose-headers":
		"electric-handle, electric-offset, electric-schema, electric-cursor, electric-up-to-date",
	vary: "Authorization",
})

export interface SyncAnswer {
	readonly response: Response | Promise<Response>
	/** The shape a non-live request asked for, for the call log (`shape:<table>`). */
	readonly logged?: { readonly table: string; readonly payload: unknown }
}

/** Answers one shape request from the dataset; live polls never enter the call log (timing-dependent). */
export const handleSyncRequest = (request: Request, dataset: Dataset, authorized: boolean): SyncAnswer => {
	const url = new URL(request.url)
	const synced = syncedTableOf(url)
	const cors = electricCorsHeaders(request)
	if (synced === undefined)
		return {
			response: Response.json(
				{ message: `ui-parity: unknown shape ${url.search}` },
				{ status: 400, headers: cors },
			),
		}
	if (!authorized)
		return { response: Response.json({ message: "Unauthorized" }, { status: 401, headers: cors }) }
	const spec = SYNCED_TABLES[synced]
	const live = url.searchParams.get("live") === "true"
	const headers = {
		...cors,
		"content-type": "application/json",
		"cache-control": "no-store",
		"electric-handle": `parity-${dataset.name}-${synced}`,
		"electric-offset": "0_0",
		"electric-schema": JSON.stringify(
			Object.fromEntries(Object.entries(spec.columns).map(([column, type]) => [column, { type }])),
		),
		"electric-up-to-date": "",
		"electric-cursor": "0",
	}
	if (live) {
		const body = JSON.stringify([UP_TO_DATE])
		return { response: Bun.sleep(LIVE_POLL_DELAY_MS).then(() => new Response(body, { headers })) }
	}
	const scope = url.searchParams.get("scope")
	const body = JSON.stringify([...encodeRows(synced, dataset.synced[synced] ?? [], scope), UP_TO_DATE])
	return {
		response: new Response(body, { headers }),
		logged: {
			table: spec.table,
			payload: { shape: synced, ...(scope === null ? undefined : { scope }) },
		},
	}
}
