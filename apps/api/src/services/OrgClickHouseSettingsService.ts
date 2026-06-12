import {
	IsoDateTimeString,
	OrgClickHouseApplySchemaStarted,
	OrgClickHouseApplySchemaStatus,
	OrgClickHouseCollectorConfigResponse,
	OrgClickHouseSchemaDiffResponse,
	OrgClickHouseSettingsDeleteResponse,
	OrgClickHouseSettingsEncryptionError,
	OrgClickHouseSettingsForbiddenError,
	OrgClickHouseSettingsPersistenceError,
	OrgClickHouseSettingsResponse,
	OrgClickHouseSettingsUpstreamRejectedError,
	OrgClickHouseSettingsUpstreamUnavailableError,
	OrgClickHouseSettingsValidationError,
	type OrgClickHouseSettingsUpsertRequest,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import {
	CLICKHOUSE_MV_SOURCE_TABLES,
	clickHouseProjectRevision,
	computeSchemaDiff,
	migrations as clickHouseMigrations,
	parseEmittedStatement,
	qualifyStatementForDatabase,
	type ActualTable,
	type DesiredTable,
} from "@maple/domain/clickhouse"
import { orgClickHouseSchemaApplyRuns, orgClickHouseSettings } from "@maple/db"
import { eq } from "drizzle-orm"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Clock, Context, Duration, Effect, Layer, Option, Redacted, Ref, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
	decryptAes256Gcm,
	encryptAes256Gcm,
	parseBase64Aes256GcmKey,
	type EncryptedValue,
} from "../lib/Crypto"
import { Database } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { dateToMs } from "../lib/time"
import { validateExternalUrl } from "../lib/url-validator"

/**
 * Resolved per-org backend config, returned to the runtime SQL layer.
 *
 * Only ClickHouse is supported for BYO now — the BYO-Tinybird path was
 * retired. Default Maple-managed Tinybird Cloud rows have no persisted
 * settings row, so callers will see `Option.none()` from
 * `resolveRuntimeConfig` for those orgs.
 */
export type RuntimeBackendConfig = {
	readonly backend: "clickhouse"
	readonly url: string
	readonly user: string
	readonly password: string
	readonly database: string
}

type ActiveRow = typeof orgClickHouseSettings.$inferSelect

const ROOT_ROLE = Schema.decodeUnknownSync(RoleName)("root")
const ORG_ADMIN_ROLE = Schema.decodeUnknownSync(RoleName)("org:admin")
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)

export interface OrgClickHouseSettingsServiceShape {
	readonly get: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseSettingsResponse,
		OrgClickHouseSettingsForbiddenError | OrgClickHouseSettingsPersistenceError
	>
	readonly upsert: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		payload: OrgClickHouseSettingsUpsertRequest,
	) => Effect.Effect<
		OrgClickHouseSettingsResponse,
		| OrgClickHouseSettingsForbiddenError
		| OrgClickHouseSettingsValidationError
		| OrgClickHouseSettingsPersistenceError
		| OrgClickHouseSettingsEncryptionError
		| OrgClickHouseSettingsUpstreamRejectedError
		| OrgClickHouseSettingsUpstreamUnavailableError
	>
	readonly delete: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseSettingsDeleteResponse,
		OrgClickHouseSettingsForbiddenError | OrgClickHouseSettingsPersistenceError
	>
	readonly schemaDiff: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseSchemaDiffResponse,
		| OrgClickHouseSettingsForbiddenError
		| OrgClickHouseSettingsValidationError
		| OrgClickHouseSettingsPersistenceError
		| OrgClickHouseSettingsEncryptionError
		| OrgClickHouseSettingsUpstreamRejectedError
		| OrgClickHouseSettingsUpstreamUnavailableError
	>
	readonly applySchema: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseApplySchemaStarted,
		| OrgClickHouseSettingsForbiddenError
		| OrgClickHouseSettingsValidationError
		| OrgClickHouseSettingsPersistenceError
	>
	readonly applySchemaStatus: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseApplySchemaStatus,
		OrgClickHouseSettingsForbiddenError | OrgClickHouseSettingsPersistenceError
	>
	readonly resolveRuntimeConfig: (
		orgId: OrgId,
	) => Effect.Effect<
		Option.Option<RuntimeBackendConfig>,
		OrgClickHouseSettingsPersistenceError | OrgClickHouseSettingsEncryptionError
	>
	readonly collectorConfig: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseCollectorConfigResponse,
		| OrgClickHouseSettingsForbiddenError
		| OrgClickHouseSettingsValidationError
		| OrgClickHouseSettingsPersistenceError
	>
}

const toPersistenceError = (error: unknown) =>
	new OrgClickHouseSettingsPersistenceError({
		message: error instanceof Error ? error.message : "Org ClickHouse settings persistence failed",
	})

// Cloudflare Workflow binding that runs the actual (chunked, long-running)
// schema apply. Resolved off the worker env at runtime — see `apply-schema`.
const SCHEMA_APPLY_WORKFLOW_BINDING = "CLICKHOUSE_SCHEMA_APPLY_WORKFLOW"

interface WorkflowBinding {
	readonly create: (options?: {
		readonly id?: string
		readonly params?: { readonly orgId: string }
	}) => Promise<unknown>
}

const isWorkflowBinding = (value: unknown): value is WorkflowBinding =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { create?: unknown }).create === "function"

const toEncryptionError = (message: string) => new OrgClickHouseSettingsEncryptionError({ message })

const parseEncryptionKey = (raw: string): Effect.Effect<Buffer, OrgClickHouseSettingsEncryptionError> =>
	parseBase64Aes256GcmKey(raw, (message) =>
		toEncryptionError(
			message === "Expected a non-empty base64 encryption key"
				? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
				: message === "Expected base64 for exactly 32 bytes"
					? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
					: message,
		),
	)

const encryptToken = (
	plaintext: string,
	encryptionKey: Buffer,
): Effect.Effect<EncryptedValue, OrgClickHouseSettingsEncryptionError> =>
	encryptAes256Gcm(plaintext, encryptionKey, () =>
		toEncryptionError("Failed to encrypt ClickHouse password"),
	)

const decryptToken = (
	encrypted: EncryptedValue,
	encryptionKey: Buffer,
): Effect.Effect<string, OrgClickHouseSettingsEncryptionError> =>
	decryptAes256Gcm(encrypted, encryptionKey, () =>
		toEncryptionError("Failed to decrypt ClickHouse password"),
	)

// Both `qualifyStatementForDatabase` and `CLICKHOUSE_MV_SOURCE_TABLES` live
// in `@maple/domain/clickhouse` now (so the `@maple/clickhouse-cli` package
// can share them) and are imported at the top of this file. Re-exported here
// for any tests / callers that still import from this module path.
export { CLICKHOUSE_MV_SOURCE_TABLES, qualifyStatementForDatabase }

// Image reference baked into the rendered collector config. Bumping this
// here is the single edit needed to roll customers onto a newer maple-otel
// collector — the generated YAML and the documented `docker run …` command
// both pick it up.
const COLLECTOR_IMAGE_REF = "ghcr.io/makisuo/maple/otel-collector-maple:0.1.5"
const COLLECTOR_PASSWORD_ENV = "MAPLE_CLICKHOUSE_PASSWORD"

/**
 * Render a ready-to-run OpenTelemetry Collector YAML for an org's BYO
 * ClickHouse. Returned by the `collectorConfig` endpoint.
 *
 * The org's CH URL/user/database are interpolated. The password is left as
 * a `${env:MAPLE_CLICKHOUSE_PASSWORD}` reference so the rendered file is
 * safe to share over chat / email / version control.
 *
 * Pipeline shape: OTLP receivers → memory_limiter → k8sattributes (best-
 * effort, ignored if RBAC is missing) → batch → maple exporter. Same
 * shape as the maple-otel Helm chart so non-Kubernetes customers get
 * parity with K8s ones.
 */
const renderCollectorYaml = (input: {
	readonly orgId: string
	readonly endpoint: string
	readonly user: string
	readonly database: string
}): string => {
	// Hand-crafted YAML rather than a templating engine so a customer
	// reading this file sees something stable and diffable.
	const lines = [
		"# Generated by Maple — your per-org OpenTelemetry Collector config.",
		"# Run with: docker run -e " +
			COLLECTOR_PASSWORD_ENV +
			"=$PASS -v ./collector.yaml:/etc/otel/config.yaml -p 4317:4317 -p 4318:4318 " +
			COLLECTOR_IMAGE_REF,
		"",
		"extensions:",
		"  health_check:",
		"    endpoint: 0.0.0.0:13133",
		"",
		"receivers:",
		"  otlp:",
		"    protocols:",
		"      grpc:",
		"        endpoint: 0.0.0.0:4317",
		"      http:",
		"        endpoint: 0.0.0.0:4318",
		"",
		"processors:",
		"  memory_limiter:",
		"    check_interval: 1s",
		"    limit_mib: 3000",
		"    spike_limit_mib: 500",
		"  k8sattributes:",
		"    passthrough: false",
		"    pod_association:",
		"      - sources:",
		"          - from: resource_attribute",
		"            name: k8s.pod.uid",
		"      - sources:",
		"          - from: connection",
		"    extract:",
		"      metadata:",
		"        - k8s.namespace.name",
		"        - k8s.deployment.name",
		"        - k8s.statefulset.name",
		"        - k8s.daemonset.name",
		"        - k8s.cronjob.name",
		"        - k8s.job.name",
		"        - k8s.node.name",
		"        - k8s.pod.name",
		"        - k8s.pod.uid",
		"        - k8s.pod.start_time",
		"  batch:",
		"    send_batch_size: 2000",
		"    timeout: 10s",
		"",
		"exporters:",
		"  maple:",
		`    endpoint: ${quoteYaml(input.endpoint)}`,
		`    database: ${quoteYaml(input.database)}`,
		`    username: ${quoteYaml(input.user)}`,
		`    password: "$\{env:${COLLECTOR_PASSWORD_ENV}}"`,
		`    org_id: ${quoteYaml(input.orgId)}`,
		"    timeout: 30s",
		"    retry_on_failure:",
		"      enabled: true",
		"      initial_interval: 1s",
		"      max_interval: 30s",
		"      max_elapsed_time: 300s",
		"    sending_queue:",
		"      enabled: true",
		"      num_consumers: 8",
		"      queue_size: 10000",
		"",
		"service:",
		"  extensions: [health_check]",
		"  pipelines:",
		"    traces:",
		"      receivers: [otlp]",
		// k8sattributes is harmless when RBAC isn't present (it just no-ops),
		// so leave it in the pipeline by default — customers running on K8s
		// get free enrichment, customers on Docker/bare-metal pay nothing.
		"      processors: [memory_limiter, k8sattributes, batch]",
		"      exporters: [maple]",
		"    logs:",
		"      receivers: [otlp]",
		"      processors: [memory_limiter, k8sattributes, batch]",
		"      exporters: [maple]",
		"    metrics:",
		"      receivers: [otlp]",
		"      processors: [memory_limiter, k8sattributes, batch]",
		"      exporters: [maple]",
		"  telemetry:",
		"    logs:",
		"      level: info",
	]
	return lines.join("\n") + "\n"
}

/**
 * Quote a YAML scalar so any `:` / `#` / leading-whitespace doesn't break
 * the serialiser. We always wrap in double quotes for predictability.
 */
const quoteYaml = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

const normalizeHttpUrl = (raw: string): Effect.Effect<string, OrgClickHouseSettingsValidationError> =>
	validateExternalUrl(raw).pipe(
		Effect.map(() => raw.trim().replace(/\/+$/, "")),
		Effect.mapError(
			(error) =>
				new OrgClickHouseSettingsValidationError({
					message: error.message,
				}),
		),
	)

const isOrgAdmin = (roles: ReadonlyArray<RoleName>) =>
	roles.includes(ROOT_ROLE) || roles.includes(ORG_ADMIN_ROLE)

const isIsoDateTime = (value: Date | null | undefined) =>
	value == null ? null : decodeIsoDateTimeStringSync(value.toISOString())

const decodeStatus = (raw: string | null | undefined): "connected" | "error" | null => {
	if (raw === "connected" || raw === "error") return raw
	return null
}

// --- Desired-schema parsing --------------------------------------------------
//
// We parse the bundled snapshot statements from the static migration snapshot.
// Parsing is cheap, but the snapshot is also static across the process
// lifetime so the service memoizes the result in a `Ref` (created in `make`)
// to avoid re-parsing on every request without resorting to module-global
// mutable state.

const parseDesiredTables = (): ReadonlyArray<DesiredTable> => {
	const out: DesiredTable[] = []
	for (const stmt of clickHouseMigrations[0]?.statements ?? []) {
		// The snapshot (migration 0001) is pure DDL strings; backfill specs (only
		// in later migrations) carry no desired-table shape, so skip them.
		if (typeof stmt !== "string") continue
		const parsed = parseEmittedStatement(stmt)
		if (!parsed) continue
		out.push({
			name: parsed.name,
			kind: parsed.kind,
			columns: parsed.kind === "table" ? parsed.columns : [],
			createStatement: stmt,
		})
	}
	return out
}

// --- ClickHouse HTTP exec helpers --------------------------------------------

export interface ClickHouseExecConfig {
	readonly url: string
	readonly user: string
	readonly password: string
	readonly database: string
}

const buildClickHouseHeaders = (config: ClickHouseExecConfig): Record<string, string> => {
	const headers: Record<string, string> = {
		"Content-Type": "text/plain",
		"X-ClickHouse-User": config.user,
		"X-ClickHouse-Database": config.database,
	}
	if (config.password.length > 0) {
		headers["X-ClickHouse-Key"] = config.password
	}
	return headers
}

const buildClickHouseUrl = (config: ClickHouseExecConfig): string =>
	// Send the database as a URL parameter as well: ClickHouse Cloud's new
	// analyzer (24.x+) sometimes fails to resolve unqualified table identifiers
	// in materialized view bodies even when the X-ClickHouse-Database header is
	// set, surfacing as `Code: 60. UNKNOWN_TABLE`.
	`${config.url.replace(/\/$/, "")}/?database=${encodeURIComponent(config.database)}`

// Per-request timeout for ClickHouse HTTP calls. Maple's API runs on Cloudflare
// Workers, whose *outbound* fetch is capped at ~100s — a hung request to an
// unreachable/slow cluster would otherwise resolve to an opaque Cloudflare 524
// (`error code: 524`) only after the full 100s. We abort well before that so the
// failure is fast and the message is actionable. Metadata DDL + the system.*
// introspection queries all respond in well under this.
const CLICKHOUSE_EXEC_TIMEOUT_MS = 20_000

// Retry only transient *infrastructure* failures (gateway/proxy 5xx, dropped
// connections). NOT retried: ClickHouse query/DDL errors (HTTP 500 carries the
// DB::Exception text — retrying a bad statement is pointless), and our own
// request timeouts (statusCode 408 — a 20s hang won't clear on an immediate
// retry; fail fast and let the user retry once the cluster is reachable).
const CLICKHOUSE_RETRY_SCHEDULE = Schedule.exponential("100 millis", 2.0).pipe(
	Schedule.both(Schedule.recurs(2)),
)

export const isRetryableUpstream = (
	error: OrgClickHouseSettingsUpstreamRejectedError | OrgClickHouseSettingsUpstreamUnavailableError,
): boolean => {
	if (!(error instanceof OrgClickHouseSettingsUpstreamUnavailableError)) return false
	const status = error.statusCode
	if (status === null) return true // network-level failure (reset/refused) — cheap to retry
	// Gateway/proxy codes that are typically transient. 500/501 are excluded:
	// ClickHouse returns 500 for genuine SQL/DDL errors; 408 is our own timeout.
	return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 529)
}

const describeUpstream5xx = (status: number, message: string): string => {
	// A 52x with the literal `error code: 5xx` body is Cloudflare's synthetic
	// timeout/origin-error page: Maple's Worker fetch to ClickHouse exceeded
	// Cloudflare's ~100s edge timeout because the endpoint didn't respond.
	if (status >= 520 && status <= 529) {
		return (
			`ClickHouse did not respond in time (Cloudflare ${status}). The cluster is unreachable ` +
			`or too slow from Maple's network — check the endpoint's firewall / IP allowlist ` +
			`(Maple's API egresses from Cloudflare and cannot be reliably IP-allowlisted; prefer ` +
			`auth + TLS without source-IP restrictions) and that the cluster is up. Upstream: ${message}`
		)
	}
	return `ClickHouse upstream error (${status}): ${message}`
}

const mapStatusToError = (
	status: number,
	text: string,
): Effect.Effect<
	never,
	OrgClickHouseSettingsUpstreamRejectedError | OrgClickHouseSettingsUpstreamUnavailableError
> => {
	const message = text.split("\n")[0]?.slice(0, 500) ?? ""
	if (status === 401 || status === 403) {
		return Effect.fail(
			new OrgClickHouseSettingsUpstreamRejectedError({
				message: `ClickHouse rejected credentials: ${message}`,
				statusCode: status,
			}),
		)
	}
	if (status >= 500) {
		return Effect.fail(
			new OrgClickHouseSettingsUpstreamUnavailableError({
				message: describeUpstream5xx(status, message),
				statusCode: status,
			}),
		)
	}
	return Effect.fail(
		new OrgClickHouseSettingsUpstreamRejectedError({
			message: `ClickHouse rejected statement (${status}): ${message}`,
			statusCode: status,
		}),
	)
}

export const execClickHouse = (config: ClickHouseExecConfig, sql: string) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const request = HttpClientRequest.post(buildClickHouseUrl(config), {
			headers: buildClickHouseHeaders(config),
		}).pipe(HttpClientRequest.bodyText(sql))
		const response = yield* client.execute(request)
		const text = yield* response.text
		return { status: response.status, text }
	}).pipe(
		// Transport-level failures (DNS, connection reset/refused, body read) →
		// retryable "unreachable" with no status.
		Effect.mapError(
			(error) =>
				new OrgClickHouseSettingsUpstreamUnavailableError({
					message: `Could not reach ClickHouse: ${error.message}`,
					statusCode: null,
				}),
		),
		Effect.flatMap(
			({
				status,
				text,
			}): Effect.Effect<
				string,
				OrgClickHouseSettingsUpstreamRejectedError | OrgClickHouseSettingsUpstreamUnavailableError
			> => (status >= 200 && status < 300 ? Effect.succeed(text) : mapStatusToError(status, text)),
		),
		// Per-attempt deadline. On timeout the fiber is interrupted — HttpClient
		// passes the abort signal to fetch, so the in-flight request is actually
		// cancelled — and we fail with a 408, excluded from the retry policy, so an
		// unreachable cluster surfaces fast instead of riding Cloudflare's ~100s
		// edge timeout into an opaque 524.
		Effect.timeoutOrElse({
			duration: Duration.millis(CLICKHOUSE_EXEC_TIMEOUT_MS),
			orElse: () =>
				Effect.fail(
					new OrgClickHouseSettingsUpstreamUnavailableError({
						message:
							`Request to ClickHouse timed out after ${CLICKHOUSE_EXEC_TIMEOUT_MS / 1000}s. ` +
							`The cluster is reachable but slow, or unreachable from Maple's network. ` +
							`Maple's API egresses from Cloudflare — if your ClickHouse endpoint has an IP ` +
							`allowlist / firewall it must accept that egress (prefer auth + TLS without ` +
							`source-IP restrictions).`,
						statusCode: 408,
					}),
				),
		}),
		Effect.retry({ schedule: CLICKHOUSE_RETRY_SCHEDULE, while: isRetryableUpstream }),
		Effect.provide(FetchHttpClient.layer),
	)

interface ClickHouseTableRow {
	readonly name: string
	readonly engine: string
}
interface ClickHouseColumnRow {
	readonly table: string
	readonly name: string
	readonly type: string
}

const fetchActualSchema = (config: ClickHouseExecConfig) =>
	Effect.gen(function* () {
		// Tables: name + engine. Engine="MaterializedView" → MV; everything else → table.
		const tablesSql = `SELECT name, engine FROM system.tables WHERE database = '${config.database.replace(/'/g, "''")}' FORMAT JSONEachRow`
		const tablesText = yield* execClickHouse(config, tablesSql)
		const tableRows = parseJsonEachRow<ClickHouseTableRow>(tablesText)

		const columnsSql = `SELECT table, name, type FROM system.columns WHERE database = '${config.database.replace(/'/g, "''")}' FORMAT JSONEachRow`
		const columnsText = yield* execClickHouse(config, columnsSql)
		const columnRows = parseJsonEachRow<ClickHouseColumnRow>(columnsText)

		const colsByTable = new Map<string, Array<{ name: string; type: string }>>()
		for (const row of columnRows) {
			const list = colsByTable.get(row.table) ?? []
			list.push({ name: row.name, type: row.type })
			colsByTable.set(row.table, list)
		}

		const result = new Map<string, ActualTable>()
		for (const t of tableRows) {
			result.set(t.name, {
				name: t.name,
				kind: t.engine === "MaterializedView" ? "materialized_view" : "table",
				columns: colsByTable.get(t.name) ?? [],
			})
		}
		return result
	})

const parseJsonEachRow = <T>(text: string): ReadonlyArray<T> => {
	const out: T[] = []
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (trimmed.length === 0) continue
		try {
			out.push(JSON.parse(trimmed) as T)
		} catch {
			// Skip malformed rows — the entire response is from us-controlled
			// queries against system.* tables, so this is defence-in-depth.
		}
	}
	return out
}

// The migration runner + backfill chunking now live in the background
// schema-apply Workflow (apps/api/src/workflows/ClickHouseSchemaApplyWorkflow.run.ts),
// which `applySchema` kicks off. The `_maple_schema_migrations` bookkeeping
// protocol is shared with `@maple/clickhouse-cli`.

// --- Service -----------------------------------------------------------------

export class OrgClickHouseSettingsService extends Context.Service<
	OrgClickHouseSettingsService,
	OrgClickHouseSettingsServiceShape
>()("@maple/api/services/OrgClickHouseSettingsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const encryptionKey = yield* parseEncryptionKey(Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY))
		// Optional: present only inside a Worker isolate. Used to kick off the
		// background schema-apply Workflow. Read optionally so non-worker/test
		// contexts (where the binding is absent) still construct the service.
		const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)

		// Memoize the parsed desired-schema snapshot per service instance. The
		// snapshot is static, so we parse it at most once and reuse it.
		const desiredTablesCache = yield* Ref.make<ReadonlyArray<DesiredTable> | null>(null)
		const getDesiredTables = Effect.gen(function* () {
			const cached = yield* Ref.get(desiredTablesCache)
			if (cached) return cached
			const parsed = parseDesiredTables()
			yield* Ref.set(desiredTablesCache, parsed)
			return parsed
		})

		const requireAdmin = Effect.fn("OrgClickHouseSettingsService.requireAdmin")(function* (
			roles: ReadonlyArray<RoleName>,
		) {
			if (isOrgAdmin(roles)) return
			return yield* Effect.fail(
				new OrgClickHouseSettingsForbiddenError({
					message: "Only org admins can manage ClickHouse settings",
				}),
			)
		})

		const selectActiveRow = Effect.fn("OrgClickHouseSettingsService.selectActiveRow")(function* (
			orgId: OrgId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(orgClickHouseSettings)
						.where(eq(orgClickHouseSettings.orgId, orgId))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return Option.fromNullishOr(rows[0])
		})

		const requireActiveRow = Effect.fn("OrgClickHouseSettingsService.requireActiveRow")(function* (
			orgId: OrgId,
		) {
			const row = yield* selectActiveRow(orgId)
			if (Option.isSome(row)) return row.value
			return yield* Effect.fail(
				new OrgClickHouseSettingsValidationError({
					message: "BYO ClickHouse is not configured for this org",
				}),
			)
		})

		const decryptStoredPassword = (
			row: ActiveRow,
		): Effect.Effect<string, OrgClickHouseSettingsEncryptionError> =>
			row.chPasswordCiphertext !== null && row.chPasswordIv !== null && row.chPasswordTag !== null
				? decryptToken(
						{
							ciphertext: row.chPasswordCiphertext,
							iv: row.chPasswordIv,
							tag: row.chPasswordTag,
						},
						encryptionKey,
					)
				: Effect.succeed("")

		const toResponse = (row: ActiveRow | null | undefined): OrgClickHouseSettingsResponse =>
			new OrgClickHouseSettingsResponse({
				configured: row != null,
				chUrl: row?.chUrl ?? null,
				chUser: row?.chUser ?? null,
				chDatabase: row?.chDatabase ?? null,
				syncStatus: decodeStatus(row?.syncStatus),
				lastSyncAt: isIsoDateTime(row?.lastSyncAt ?? null),
				lastSyncError: row?.lastSyncError ?? null,
				schemaVersion: row?.schemaVersion ?? null,
			})

		const get = Effect.fn("OrgClickHouseSettingsService.get")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			const row = yield* selectActiveRow(orgId)
			return toResponse(Option.getOrUndefined(row))
		})

		const upsert = Effect.fn("OrgClickHouseSettingsService.upsert")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
			payload: OrgClickHouseSettingsUpsertRequest,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("userId", userId)
			yield* requireAdmin(roles)

			const url = yield* normalizeHttpUrl(payload.url)
			const user = payload.user.trim()
			const dbName = payload.database.trim()
			if (user.length === 0) {
				return yield* new OrgClickHouseSettingsValidationError({
					message: "ClickHouse user is required",
				})
			}
			if (dbName.length === 0) {
				return yield* new OrgClickHouseSettingsValidationError({
					message: "ClickHouse database is required",
				})
			}

			// If the user left the password blank on a re-save, reuse the existing
			// stored password (decrypted from the previous row) ONLY when the URL,
			// user, and database are unchanged. Otherwise we'd be silently sending
			// the stored credential to a different host — an SSRF / credential
			// disclosure path. Force the user to re-enter the password when any
			// connection identifier changes.
			const existingRow = yield* selectActiveRow(orgId)
			let plainPassword = (payload.password ?? "").trim()
			if (plainPassword.length === 0 && Option.isSome(existingRow)) {
				const existing = existingRow.value
				const sameEndpoint =
					existing.chUrl === url && existing.chUser === user && existing.chDatabase === dbName
				if (!sameEndpoint) {
					return yield* new OrgClickHouseSettingsValidationError({
						message: "Password is required when changing the ClickHouse URL, user, or database",
					})
				}
				plainPassword = yield* decryptStoredPassword(existing)
			}

			// Connect-and-validate: hit the cluster with `SELECT 1` so a typo'd
			// host or token surfaces here rather than after the user closes the
			// dialog. No DDL is run — applying the schema is a separate explicit
			// action via the diff/apply endpoints.
			yield* execClickHouse({ url, user, password: plainPassword, database: dbName }, "SELECT 1")

			const encryptedPassword =
				plainPassword.length > 0 ? yield* encryptToken(plainPassword, encryptionKey) : null

			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db
						.insert(orgClickHouseSettings)
						.values({
							orgId,
							chUrl: url,
							chUser: user,
							chPasswordCiphertext: encryptedPassword?.ciphertext ?? null,
							chPasswordIv: encryptedPassword?.iv ?? null,
							chPasswordTag: encryptedPassword?.tag ?? null,
							chDatabase: dbName,
							syncStatus: "connected",
							lastSyncAt: new Date(now),
							lastSyncError: null,
							// schemaVersion is preserved across re-saves — credentials
							// changing doesn't invalidate the schema apply state.
							schemaVersion: Option.isSome(existingRow)
								? existingRow.value.schemaVersion
								: null,
							createdAt: Option.isSome(existingRow) ? existingRow.value.createdAt : new Date(now),
							updatedAt: new Date(now),
							createdBy: Option.isSome(existingRow) ? existingRow.value.createdBy : userId,
							updatedBy: userId,
						})
						.onConflictDoUpdate({
							target: orgClickHouseSettings.orgId,
							set: {
								chUrl: url,
								chUser: user,
								chPasswordCiphertext: encryptedPassword?.ciphertext ?? null,
								chPasswordIv: encryptedPassword?.iv ?? null,
								chPasswordTag: encryptedPassword?.tag ?? null,
								chDatabase: dbName,
								syncStatus: "connected",
								lastSyncAt: new Date(now),
								lastSyncError: null,
								updatedAt: new Date(now),
								updatedBy: userId,
							},
						}),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const refreshed = yield* selectActiveRow(orgId)
			return toResponse(Option.getOrUndefined(refreshed))
		})

		const deleteSettings = Effect.fn("OrgClickHouseSettingsService.delete")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			yield* database
				.execute((db) =>
					db.delete(orgClickHouseSettings).where(eq(orgClickHouseSettings.orgId, orgId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return new OrgClickHouseSettingsDeleteResponse({ configured: false })
		})

		const loadConfigForRow = (row: ActiveRow) =>
			Effect.map(decryptStoredPassword(row), (password) => ({
				url: row.chUrl,
				user: row.chUser,
				password,
				database: row.chDatabase,
			}))

		const schemaDiff = Effect.fn("OrgClickHouseSettingsService.schemaDiff")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			const row = yield* requireActiveRow(orgId)
			const config = yield* loadConfigForRow(row)
			const actual = yield* fetchActualSchema(config)
			const entries = computeSchemaDiff({ tables: yield* getDesiredTables }, actual)
			return new OrgClickHouseSchemaDiffResponse({
				expectedSchemaVersion: clickHouseProjectRevision,
				appliedSchemaVersion: row.schemaVersion ?? null,
				entries,
			})
		})

		// Kick off the background schema-apply Workflow. The heavy work (chunked
		// backfill migrations + snapshot-diff reconcile) runs there so it never
		// hits the Worker request budget; the client polls `applySchemaStatus`.
		const applySchema = Effect.fn("OrgClickHouseSettingsService.applySchema")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("userId", userId)
			yield* requireAdmin(roles)
			// Ensure BYO ClickHouse is configured before queuing a run.
			yield* requireActiveRow(orgId)

			const existing = yield* database
				.execute((db) =>
					db
						.select()
						.from(orgClickHouseSchemaApplyRuns)
						.where(eq(orgClickHouseSchemaApplyRuns.orgId, orgId))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const current = existing[0]
			if (current && (current.status === "queued" || current.status === "running")) {
				return new OrgClickHouseApplySchemaStarted({ status: "already_running" })
			}

			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db
						.insert(orgClickHouseSchemaApplyRuns)
						.values({
							orgId,
							workflowInstanceId: null,
							status: "queued",
							phase: "queued",
							currentMigration: null,
							stepsTotal: null,
							stepsDone: null,
							appliedVersions: null,
							skipped: null,
							errorMessage: null,
							startedAt: null,
							finishedAt: null,
							createdAt: new Date(now),
							updatedAt: new Date(now),
						})
						.onConflictDoUpdate({
							target: orgClickHouseSchemaApplyRuns.orgId,
							set: {
								status: "queued",
								phase: "queued",
								currentMigration: null,
								stepsTotal: null,
								stepsDone: null,
								appliedVersions: null,
								skipped: null,
								errorMessage: null,
								startedAt: null,
								finishedAt: null,
								updatedAt: new Date(now),
							},
						}),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const binding = Option.match(workerEnv, {
				onNone: () => undefined,
				onSome: (e) => e[SCHEMA_APPLY_WORKFLOW_BINDING],
			})
			if (!isWorkflowBinding(binding)) {
				return yield* Effect.fail(
					new OrgClickHouseSettingsPersistenceError({
						message: `Schema-apply workflow binding (${SCHEMA_APPLY_WORKFLOW_BINDING}) unavailable`,
					}),
				)
			}
			yield* Effect.tryPromise({
				try: () => binding.create({ params: { orgId } }),
				catch: (error) =>
					new OrgClickHouseSettingsPersistenceError({
						message: `Failed to start schema-apply workflow: ${error instanceof Error ? error.message : String(error)}`,
					}),
			})

			return new OrgClickHouseApplySchemaStarted({ status: "started" })
		})

		const applySchemaStatus = Effect.fn("OrgClickHouseSettingsService.applySchemaStatus")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(orgClickHouseSchemaApplyRuns)
						.where(eq(orgClickHouseSchemaApplyRuns.orgId, orgId))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const row = rows[0]
			if (!row) {
				return new OrgClickHouseApplySchemaStatus({
					status: "idle",
					phase: null,
					currentMigration: null,
					stepsTotal: null,
					stepsDone: null,
					appliedVersions: [],
					errorMessage: null,
					startedAt: null,
					finishedAt: null,
				})
			}
			let appliedVersions: ReadonlyArray<number> = []
			if (Array.isArray(row.appliedVersions)) {
				appliedVersions = row.appliedVersions.map((v) => Number(v))
			}
			const status =
				row.status === "queued" ||
				row.status === "running" ||
				row.status === "succeeded" ||
				row.status === "failed"
					? row.status
					: "idle"
			return new OrgClickHouseApplySchemaStatus({
				status,
				phase: row.phase ?? null,
				currentMigration: row.currentMigration ?? null,
				stepsTotal: row.stepsTotal ?? null,
				stepsDone: row.stepsDone ?? null,
				appliedVersions,
				errorMessage: row.errorMessage ?? null,
				startedAt: dateToMs(row.startedAt),
				finishedAt: dateToMs(row.finishedAt),
			})
		})

		const resolveRuntimeConfig = Effect.fn("OrgClickHouseSettingsService.resolveRuntimeConfig")(
			function* (orgId: OrgId) {
				const row = yield* selectActiveRow(orgId)
				if (Option.isNone(row)) {
					return Option.none<RuntimeBackendConfig>()
				}
				const password = yield* decryptStoredPassword(row.value)
				return Option.some<RuntimeBackendConfig>({
					backend: "clickhouse",
					url: row.value.chUrl,
					user: row.value.chUser,
					password,
					database: row.value.chDatabase,
				})
			},
		)

		const collectorConfig = Effect.fn("OrgClickHouseSettingsService.collectorConfig")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			const row = yield* requireActiveRow(orgId)
			const yaml = renderCollectorYaml({
				orgId,
				endpoint: row.chUrl,
				user: row.chUser,
				database: row.chDatabase,
			})
			return new OrgClickHouseCollectorConfigResponse({
				yaml,
				image: COLLECTOR_IMAGE_REF,
				passwordEnvVar: COLLECTOR_PASSWORD_ENV,
			})
		})

		return {
			get,
			upsert,
			delete: deleteSettings,
			schemaDiff,
			applySchema,
			applySchemaStatus,
			resolveRuntimeConfig,
			collectorConfig,
		} satisfies OrgClickHouseSettingsServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)

	static readonly get = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.get(orgId, roles))

	static readonly upsert = (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		payload: OrgClickHouseSettingsUpsertRequest,
	) => this.use((service) => service.upsert(orgId, userId, roles, payload))

	static readonly delete = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.delete(orgId, roles))

	static readonly resolveRuntimeConfig = (orgId: OrgId) =>
		this.use((service) => service.resolveRuntimeConfig(orgId))

	static readonly collectorConfig = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.collectorConfig(orgId, roles))
}
