import { Effect, Predicate } from "effect"
import { CH } from "@maple/query-engine"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import * as Integrations from "@maple/query-engine-integrations"
import { parityOrgId, type FixtureWarehouse } from "../../backend/warehouse.ts"
import type { FixtureArea } from "../areas.ts"
import type { Dataset, EndpointHandler } from "../dataset.ts"
import { DAY, FROZEN_NOW, FROZEN_NOW_MS, HOUR, MINUTE, fixtureUuid } from "../identity.ts"
import {
	CF_ACCOUNT_ID,
	CF_ZONES,
	GCP_PROJECT,
	infraIntegrationsTelemetry,
	PS_DATABASES,
	RAILWAY_ENVIRONMENTS,
	RAILWAY_PROJECT,
	RAILWAY_SERVICES,
} from "../telemetry/infra-integrations.ts"
import { integrationWarehouseEndpoints } from "./infra-integrations-warehouse.ts"

/**
 * Infrastructure integrations (Cloudflare, Railway, Google Cloud, PlanetScale) on their own org,
 * `infra-integrations`, so the default org's captures never shift. Status reads are Postgres or
 * provider APIs in prd and are canned here; every warehouse read runs the API's query code.
 */

const identity = {
	orgId: "org_parity_infra_int",
	userId: "user_parity_ada",
	email: "ada@acme.test",
	name: "Ada Lovelace",
	orgName: "Acme Shop",
	orgSlug: "acme-shop",
	role: "admin",
} as const

const iso = (ms: number) => new Date(ms).toISOString()
const connectedAt = FROZEN_NOW_MS - 21 * DAY

const cloudflareZone = (name: string, index: number) => ({
	id: `cfzone${index}0000000000000000000000000`.slice(0, 32),
	name,
	enabled: true,
	lastSyncedAt: FROZEN_NOW_MS - 2 * MINUTE,
	lastError: null,
	watermarkAt: FROZEN_NOW_MS - 10 * MINUTE,
	backfillAt: null,
})

const cloudflareWorkersStatus = {
	enabled: true,
	lastSyncedAt: FROZEN_NOW_MS - 2 * MINUTE,
	lastError: null,
	watermarkAt: FROZEN_NOW_MS - 10 * MINUTE,
	backfillAt: null,
}

const cloudflareStatus = {
	connected: true,
	accountId: CF_ACCOUNT_ID,
	accountName: "Acme Shop",
	connectedByUserId: identity.userId,
	scope: "account:read zone:read analytics:read workers_scripts:read",
	analyticsCapable: true,
	connectedAt,
	accounts: [
		{
			accountId: CF_ACCOUNT_ID,
			accountName: "Acme Shop",
			connectedByUserId: identity.userId,
			scope: "account:read zone:read analytics:read workers_scripts:read",
			analyticsCapable: true,
			revoked: false,
			zones: CF_ZONES.map(cloudflareZone),
			workers: cloudflareWorkersStatus,
		},
	],
	zones: CF_ZONES.map(cloudflareZone),
	workers: cloudflareWorkersStatus,
}

const railwayStatus = {
	connected: true,
	workspaceNames: "Acme Shop",
	connectedByUserId: identity.userId,
	connectedAt,
	authFailed: false,
	lastSyncedAt: FROZEN_NOW_MS - MINUTE,
	lastError: null,
	environments: RAILWAY_ENVIRONMENTS.map((environment, index) => ({
		projectId: RAILWAY_PROJECT.id,
		projectName: RAILWAY_PROJECT.name,
		environmentId: environment.id,
		environmentName: environment.name,
		serviceCount: RAILWAY_SERVICES.filter((service) => service.env === index).length,
		enabled: true,
		lastSyncedAt: FROZEN_NOW_MS - MINUTE,
		lastError: null,
	})),
}

const planetscaleStatus = {
	object: "planetscale_integration",
	connected: true,
	pending_org_selection: false,
	organization: "acme",
	connected_by_user_id: identity.userId,
	detected_permissions: { readMetricsEndpoints: true },
	metrics_auth: "service_token",
	scrape_target: {
		id: encodePublicId(PublicIdPrefixes.scrapeTarget, fixtureUuid(40, 1)),
		object: "planetscale_integration.scrape_target",
		enabled: true,
		scrape_interval_seconds: 60,
		include_branches: [],
		exclude_branches: ["pr-*"],
		last_scrape_at: iso(FROZEN_NOW_MS - MINUTE),
		last_scrape_error: null,
	},
	last_inventory_at: iso(FROZEN_NOW_MS - 10 * MINUTE),
	last_inventory_error: null,
	revoked_at: null,
	expires_at: iso(FROZEN_NOW_MS + 2 * HOUR),
}

const planetscaleDatabases = {
	object: "planetscale_integration.database_list",
	databases: PS_DATABASES.map((database, index) => ({
		id: `database/ps${index + 1}`,
		object: "planetscale_integration.database",
		name: database.name,
		kind: "postgresql",
		state: "ready",
		region: "us-east",
		plan: index === 0 ? "scaler_pro" : "base",
		branches: database.branches.map((branch, branchIndex) => ({
			id: `branch/ps${index + 1}-${branchIndex + 1}`,
			name: branch,
			production: branch === "main",
			ready: true,
		})),
	})),
	last_inventory_at: iso(FROZEN_NOW_MS - 10 * MINUTE),
}

const gcpStatus = {
	object: "gcp_integration",
	metrics_available: true,
	connectors: [
		{
			id: encodePublicId(PublicIdPrefixes.gcpConnector, fixtureUuid(40, 2)),
			object: "gcp_connector",
			scope_type: "project",
			scope_id: GCP_PROJECT,
			project_id: GCP_PROJECT,
			logs_enabled: true,
			metrics_enabled: true,
			created_at: iso(connectedAt),
			last_log_received_at: iso(FROZEN_NOW_MS - MINUTE),
			last_log_error: null,
			applied_logs_enabled: true,
			applied_metrics_enabled: true,
			setup_reported_at: iso(connectedAt + 5 * MINUTE),
			last_metrics_received_at: iso(FROZEN_NOW_MS - MINUTE),
			last_metrics_error: null,
			discovered_project_count: 1,
			last_resources_error: null,
		},
	],
}

const gcpResource = (
	assetType: string,
	path: string,
	displayName: string,
	location: string | null,
	details: unknown = null,
) => ({
	name: `//${assetType.split("/")[0]}/projects/${GCP_PROJECT}/${path}`,
	assetType,
	projectId: GCP_PROJECT,
	location,
	displayName,
	state: "ACTIVE",
	labels: { env: "production" },
	details,
})

const GCP_RESOURCES = [
	gcpResource("cloudresourcemanager.googleapis.com/Project", "", GCP_PROJECT, null),
	gcpResource(
		"run.googleapis.com/Service",
		"locations/us-central1/services/checkout-api",
		"checkout-api",
		"us-central1",
	),
	gcpResource(
		"run.googleapis.com/Service",
		"locations/us-central1/services/image-worker",
		"image-worker",
		"us-central1",
	),
	gcpResource(
		"cloudfunctions.googleapis.com/CloudFunction",
		"locations/us-central1/functions/send-receipt",
		"send-receipt",
		"us-central1",
	),
	gcpResource(
		"compute.googleapis.com/Instance",
		"zones/us-central1-a/instances/batch-runner-1",
		"batch-runner-1",
		"us-central1-a",
	),
	gcpResource("sqladmin.googleapis.com/Instance", "instances/orders-db", "orders-db", "us-central1", {
		databaseVersion: "POSTGRES_15",
		edition: "ENTERPRISE",
		tier: "db-custom-4-16384",
		cpus: 4,
		memoryGb: 16,
		availabilityType: "REGIONAL",
		primary: null,
		diskSizeGb: 100,
		queryInsightsEnabled: true,
		maxConnections: 400,
		maxConnectionsSource: "default",
	}),
	gcpResource("pubsub.googleapis.com/Subscription", "subscriptions/orders-sub", "orders-sub", null),
]

const queryField = (query: unknown, key: string): string | undefined =>
	Predicate.hasProperty(query, key) && typeof query[key] === "string" ? query[key] : undefined

/** `GcpConnectorService.listResources`: filter by type, project and last name segment, then count. */
const gcpResources: EndpointHandler = ({ query }) => {
	const assetType = queryField(query, "assetType")
	const projectId = queryField(query, "projectId")
	const name = queryField(query, "name")
	const resources = GCP_RESOURCES.filter(
		(resource) =>
			(assetType === undefined || resource.assetType === assetType) &&
			(projectId === undefined || resource.projectId === projectId) &&
			(name === undefined || resource.name.endsWith(`/${name}`)),
	)
	const types = [...new Set(GCP_RESOURCES.map((resource) => resource.assetType))].sort().map((type) => ({
		assetType: type,
		count: GCP_RESOURCES.filter((resource) => resource.assetType === type).length,
	}))
	return Effect.succeed({ resources, total: resources.length, types, projects: [GCP_PROJECT] })
}

const insight = (index: number, sql: string, type: string, count: number, p50: number, p99: number) => ({
	object: "planetscale_integration.query_insight",
	fingerprint: `fp${index.toString().padStart(6, "0")}`,
	normalized_sql: sql,
	statement_type: type,
	query_count: count,
	error_count: index === 3 ? 12 : 0,
	total_duration_millis: count * p50 * 1.3,
	time_per_query_millis: p50 * 1.3,
	p50_latency_millis: p50,
	p99_latency_millis: p99,
	rows_read_per_query: 40 * index,
	rows_returned_per_query: index,
	last_run_at: iso(FROZEN_NOW_MS - index * MINUTE),
})

const planetscaleInsights: EndpointHandler = () =>
	Effect.succeed({
		object: "planetscale_integration.query_insight_list",
		branch: "main",
		data: [
			insight(
				1,
				"SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2",
				"SELECT",
				182_400,
				1.8,
				14.2,
			),
			insight(2, "UPDATE carts SET updated_at = now() WHERE id = $1", "UPDATE", 64_120, 0.9, 6.4),
			insight(
				3,
				"INSERT INTO payments (order_id, amount, status) VALUES ($1, $2, $3)",
				"INSERT",
				21_870,
				3.2,
				41.5,
			),
			insight(
				4,
				"SELECT count(*) FROM order_items WHERE order_id = ANY($1)",
				"SELECT",
				9_340,
				12.4,
				88.1,
			),
		],
		unavailable_reason: null,
	})

const planetscaleEvents: EndpointHandler = () =>
	Effect.succeed({
		object: "planetscale_integration.event_list",
		data: [
			{
				id: "evt_ps_1",
				object: "planetscale_integration.event",
				database_name: "acme-prod",
				branch_name: "main",
				category: "deploy_request",
				event_type: "deploy_request.schema_applied",
				state: "complete",
				external_id: "42",
				title: "Deploy request #42 applied",
				source: "webhook",
				actor_login: "ada",
				url: "https://app.planetscale.com/acme/acme-prod/deploy-requests/42",
				occurred_at: iso(FROZEN_NOW_MS - 5 * HOUR),
			},
		],
		next_cursor: null,
	})

const emptyEvents: EndpointHandler = () =>
	Effect.succeed({ object: "planetscale_integration.event_list", data: [], next_cursor: null })
const emptyInsights: EndpointHandler = () =>
	Effect.succeed({
		object: "planetscale_integration.query_insight_list",
		branch: "main",
		data: [],
		unavailable_reason: null,
	})

const USAGE_WINDOW_MS = DAY
const USAGE_BUCKET_SECONDS = 3600
const SERVICE_KINDS = [
	["worker", "cloudflare-worker/"],
	["queue", "cloudflare-queue/"],
	["zone", "cloudflare/"],
] as const
const KIND_ORDER = { zone: 0, worker: 1, queue: 2 } as const

/** `toWarehouseDateTime64` in `CloudflareAnalyticsService`. */
const warehouseDateTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "")

/**
 * `CloudflareAnalyticsService.getUsage`: hourly ingest per Cloudflare service over the last 24 h
 * plus the previous-window and firewall stats, run on the warehouse. Not connected: all zeros.
 */
const cloudflareUsage =
	(warehouse: FixtureWarehouse, connected: boolean): EndpointHandler =>
	({ dataset }) =>
		Effect.gen(function* () {
			const now = parseWarehouseDateTime(dataset.now)
			const windowStart = now - USAGE_WINDOW_MS
			const empty = {
				windowStart,
				windowEnd: now,
				bucketSeconds: USAGE_BUCKET_SECONDS,
				totalRequests: 0,
				previousTotalRequests: 0,
				firewallBlockedEvents: 0,
				services: [],
			}
			if (!connected || dataset.identity === null) return empty
			const orgId = parityOrgId(dataset.identity.orgId)
			const tenant = warehouse.tenantOf(orgId)
			const [rows, statsRows] = yield* Effect.all([
				warehouse.executor.compiledQuery(
					tenant,
					CH.compile(Integrations.cloudflareUsageQuery(), {
						orgId,
						bucketSeconds: USAGE_BUCKET_SECONDS,
						startTime: warehouseDateTime(windowStart),
						endTime: warehouseDateTime(now),
					}),
					{ profile: "aggregation", context: "cloudflareUsage" },
				),
				warehouse.executor.compiledQuery(
					tenant,
					CH.compile(Integrations.cloudflareUsageStatsQuery(), {
						orgId,
						prevStartTime: warehouseDateTime(windowStart - USAGE_WINDOW_MS),
						currentStartTime: warehouseDateTime(windowStart),
						endTime: warehouseDateTime(now),
					}),
					{ profile: "aggregation", context: "cloudflareUsageStats" },
				),
			])
			const names = [...new Set(rows.map((row) => row.serviceName))]
			const services = names
				.map((serviceName) => {
					const own = rows.filter((row) => row.serviceName === serviceName)
					const match = SERVICE_KINDS.find(([, prefix]) => serviceName.startsWith(prefix))
					const lastTimes = own
						.map((row) => parseWarehouseDateTime(row.lastTimeUnix))
						.filter(Number.isFinite)
					return {
						serviceName,
						kind: match?.[0] ?? "zone",
						displayName: match ? serviceName.slice(match[1].length) : serviceName,
						totalRequests: own.reduce((sum, row) => sum + Math.round(row.requests), 0),
						totalDatapoints: own.reduce((sum, row) => sum + row.datapoints, 0),
						lastDataAt: lastTimes.length === 0 ? null : Math.max(...lastTimes),
						buckets: own.map((row) => ({
							bucketStart: parseWarehouseDateTime(row.bucket),
							requests: Math.round(row.requests),
							datapoints: row.datapoints,
						})),
					}
				})
				.sort((a, b) =>
					a.kind === b.kind
						? a.displayName.localeCompare(b.displayName)
						: KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
				)
			return {
				...empty,
				totalRequests: services.reduce((sum, service) => sum + service.totalRequests, 0),
				previousTotalRequests: Math.round(statsRows[0]?.previousRequests ?? 0),
				firewallBlockedEvents: Math.round(statsRows[0]?.firewallBlockedEvents ?? 0),
				services,
			}
		})

const constant =
	(value: unknown): EndpointHandler =>
	() =>
		Effect.succeed(value)

export const INFRA_INTEGRATIONS_DATASET = "infra-integrations"

/** What the connected org reads besides its connection state: mostly real warehouse reads. */
const connectedEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	...integrationWarehouseEndpoints(warehouse),
	"integrations.cloudflareUsage": cloudflareUsage(warehouse, true),
	"planetscaleIntegration.queryInsights": planetscaleInsights,
	"planetscaleIntegration.events": planetscaleEvents,
	"integrations.gcpResources": gcpResources,
})

/** Connection state the shared defaults answer as not connected: overridden for this org only. */
const connectionState = {
	"integrations.cloudflareStatus": constant(cloudflareStatus),
	"integrations.railwayStatus": constant(railwayStatus),
	"planetscaleIntegration.status": constant(planetscaleStatus),
	"planetscaleIntegration.databases": constant(planetscaleDatabases),
	"gcpIntegration.status": constant(gcpStatus),
} satisfies Readonly<Record<string, EndpointHandler>>

/**
 * What every other org reads. Tags the shared backend already answers keep exactly that answer
 * (`src/backend/endpoints/index.ts`, `src/backend/defaults.ts`); the rest run the same code over no rows.
 */
const otherOrgEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	...integrationWarehouseEndpoints(warehouse),
	"queryEngine.serviceCloudflareStats": constant({ data: [] }),
	"queryEngine.servicePlanetScaleStats": constant({ data: [] }),
	"queryEngine.railwayInfraServices": constant({ data: [] }),
	"queryEngine.gcpInfraPresence": constant({ services: [] }),
	"queryEngine.cloudflareInfraZones": constant({ data: [], ignoredFilters: [] }),
	"integrations.cloudflareUsage": cloudflareUsage(warehouse, false),
	"planetscaleIntegration.queryInsights": emptyInsights,
	"planetscaleIntegration.events": emptyEvents,
	"integrations.gcpResources": constant({ resources: [], total: 0, types: [], projects: [] }),
})

/** One handler per tag that picks the connected answer for this area's dataset only. */
const byDataset = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => {
	const connected = connectedEndpoints(warehouse)
	const other = otherOrgEndpoints(warehouse)
	return Object.fromEntries(
		Object.entries(other).map(([tag, theirs]) => {
			const mine = connected[tag] ?? theirs
			const handler: EndpointHandler = (request) =>
				(request.dataset.name === INFRA_INTEGRATIONS_DATASET ? mine : theirs)(request)
			return [tag, handler]
		}),
	)
}

const dataset: Dataset = {
	name: INFRA_INTEGRATIONS_DATASET,
	now: FROZEN_NOW,
	identity,
	auth: "self_hosted",
	endpoints: connectionState,
	synced: {},
	telemetry: infraIntegrationsTelemetry(identity.orgId, new Date(FROZEN_NOW)),
}

export const fixtureArea: FixtureArea = {
	area: "infra-integrations",
	endpoints: byDataset,
	datasets: [dataset],
}
