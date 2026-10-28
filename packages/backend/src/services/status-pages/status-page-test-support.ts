// Seeds status pages, monitors and incidents for the status-pages tests.
import { Effect, Schema } from "effect"
import { OrgId, StatusPageId } from "@maple/domain/primitives"
import { executeSql, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"

export const ORG = Schema.decodeUnknownSync(OrgId)("org_status_pages")
export const USER = "user_status_pages"
/** 2026-10-28T12:00:00Z */
export const NOW = Date.UTC(2026, 9, 28, 12)
export const DAY_MS = 86_400_000

const iso = (ms: number) => new Date(ms).toISOString()
const sql = (testDb: TestDb, text: string, params: unknown[]) =>
	Effect.promise(() => executeSql(testDb, text, params))

export const newPageId = () => StatusPageId.make(crypto.randomUUID())

export const seedPage = (
	testDb: TestDb,
	input: {
		readonly id: StatusPageId
		readonly slug: string
		readonly autoIncidents?: "off" | "draft" | "publish"
		readonly breakGlass?: boolean
		readonly revision?: number
		readonly publishedRevision?: number
		readonly publishedAt?: number | null
	},
) =>
	sql(
		testDb,
		`INSERT INTO status_pages (id, org_id, name, slug, auto_incidents, break_glass_token_sha256,
			revision, published_revision, published_at, created_by, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
		[
			input.id,
			ORG,
			`Page ${input.slug}`,
			input.slug,
			input.autoIncidents ?? "off",
			input.breakGlass === true ? "token-hash" : null,
			input.revision ?? 1,
			input.publishedRevision ?? 0,
			input.publishedAt === undefined || input.publishedAt === null ? null : iso(input.publishedAt),
			USER,
			iso(NOW - DAY_MS),
		],
	)

export const seedMonitor = (
	testDb: TestDb,
	input: { readonly id: string; readonly status: string; readonly alertRuleId?: string | null },
) =>
	sql(
		testDb,
		`INSERT INTO uptime_monitors (id, org_id, name, kind, config_json, alert_rule_id, created_by, created_at, updated_at)
		 VALUES ($1, $2, 'Monitor', 'http', $3, $4, $5, $6, $6)`,
		[
			input.id,
			ORG,
			JSON.stringify({
				_tag: "http",
				url: "https://example.com/health",
				method: "GET",
				headers: {},
				assertions: [],
				timeoutMs: 5000,
			}),
			input.alertRuleId ?? null,
			USER,
			iso(NOW - DAY_MS),
		],
	).pipe(
		Effect.andThen(
			sql(
				testDb,
				`INSERT INTO uptime_monitor_states (monitor_id, org_id, status, recent_json, updated_at)
				 VALUES ($1, $2, $3, '[]', $4)`,
				[input.id, ORG, input.status, iso(NOW)],
			),
		),
	)

export const seedDaily = (
	testDb: TestDb,
	input: {
		readonly monitorId: string
		readonly day: string
		readonly checks: number
		readonly failures: number
		readonly downChecks: number
		readonly lastCheckAt: number
	},
) =>
	sql(
		testDb,
		`INSERT INTO uptime_monitor_daily (monitor_id, day, org_id, checks, failures, down_checks, last_check_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		[
			input.monitorId,
			input.day,
			ORG,
			input.checks,
			input.failures,
			input.downChecks,
			iso(input.lastCheckAt),
		],
	)

export const seedComponent = (
	testDb: TestDb,
	input: {
		readonly id: string
		readonly pageId: string
		readonly name: string
		readonly position: number
		readonly monitorId?: string | null
		readonly manualStatus?: string | null
		readonly showUptime?: boolean
	},
) =>
	sql(
		testDb,
		`INSERT INTO status_page_components (id, org_id, page_id, name, position, monitor_id, manual_status,
			show_uptime, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
		[
			input.id,
			ORG,
			input.pageId,
			input.name,
			input.position,
			input.monitorId ?? null,
			input.manualStatus ?? null,
			input.showUptime ?? true,
			iso(NOW - DAY_MS),
		],
	)

export const seedIncident = (
	testDb: TestDb,
	input: {
		readonly id: string
		readonly pageId: string
		readonly title: string
		readonly kind?: "incident" | "maintenance"
		readonly impact?: string
		readonly status: string
		readonly published?: boolean
		readonly startedAt: number
		readonly resolvedAt?: number | null
		readonly scheduledEnd?: number | null
		readonly componentIds?: ReadonlyArray<string>
	},
) =>
	sql(
		testDb,
		`INSERT INTO status_page_incidents (id, org_id, page_id, kind, title, impact, status, published,
			scheduled_end, started_at, resolved_at, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10, $10)`,
		[
			input.id,
			ORG,
			input.pageId,
			input.kind ?? "incident",
			input.title,
			input.impact ?? "major",
			input.status,
			input.published ?? true,
			input.scheduledEnd === undefined || input.scheduledEnd === null ? null : iso(input.scheduledEnd),
			iso(input.startedAt),
			input.resolvedAt === undefined || input.resolvedAt === null ? null : iso(input.resolvedAt),
		],
	).pipe(
		Effect.andThen(
			Effect.forEach(
				input.componentIds ?? [],
				(componentId) =>
					sql(
						testDb,
						`INSERT INTO status_page_incident_components (incident_id, component_id, org_id) VALUES ($1, $2, $3)`,
						[input.id, componentId, ORG],
					),
				{ discard: true },
			),
		),
		Effect.andThen(
			sql(
				testDb,
				`INSERT INTO status_page_incident_updates (id, org_id, incident_id, status, body, source, created_at)
				 VALUES ($1, $2, $3, $4, $5, 'dashboard', $6)`,
				[
					crypto.randomUUID(),
					ORG,
					input.id,
					input.status,
					`${input.title} update`,
					iso(input.startedAt),
				],
			),
		),
	)

export const readPage = (testDb: TestDb, pageId: string) =>
	Effect.promise(() =>
		queryFirstRow<{
			revision: string
			published_revision: string
			published_at: string | null
			published_hash: string | null
			last_publish_error: string | null
		}>(
			testDb,
			`SELECT revision::text, published_revision::text, published_at::text, published_hash, last_publish_error
			 FROM status_pages WHERE id = $1`,
			[pageId],
		),
	)

export const bumpRevision = (testDb: TestDb, pageId: string) =>
	sql(testDb, `UPDATE status_pages SET revision = revision + 1 WHERE id = $1`, [pageId])
