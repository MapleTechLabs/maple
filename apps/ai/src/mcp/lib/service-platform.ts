/**
 * The connected-platform entities behind one service: the Railway service or Cloudflare Worker that
 * shares its name, and the PlanetScale databases its spans call. Matching is by exact name, the
 * only join these integrations share with traces.
 */
import type { InfraKindSection } from "@maple/domain/mcp-outputs"
import { isMissingServiceMapDbEdgesMinutely } from "@maple/backend/services/warehouse/missing-table"
import { CH } from "@maple/query-engine"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import { Effect } from "effect"
import type { InfraWindow } from "./infra"
import { listProviderKind } from "./infra-providers"

/** Fleet rows read per kind before matching; a name match needs the whole fleet. */
const FLEET_LIMIT = 1_000

const fleet = (
	kind: "railway_services" | "cloudflare_workers" | "planetscale_databases",
	window: InfraWindow,
) =>
	listProviderKind(kind, { window, filters: {}, sort: "name", limit: FLEET_LIMIT }).pipe(
		Effect.map(({ section }) => ({ rows: section.rows, truncated: section.truncated })),
	)

const NONE = { rows: [], truncated: false }

/** Databases the service's spans called (`db.namespace`), from the service-map edges. */
const calledDatabases = (service: string, window: InfraWindow) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const read = (minuteTier: boolean) =>
			executor.compiledQuery(
				CH.compile(CH.serviceDbEdgesForServiceQuery({ serviceName: service, minuteTier }), {
					orgId: executor.orgId,
					startTime: window.startTime,
					endTime: window.endTime,
				}),
				{ profile: "aggregation", context: "servicePlatformDbEdges" },
			)
		// A cluster without migration 0049 has no minute tier; the raw shape answers the same.
		const rows = yield* read(true).pipe(
			Effect.catch((error) =>
				isMissingServiceMapDbEdgesMinutely(error) ? read(false) : Effect.fail(error),
			),
		)
		return new Set(rows.map((row) => row.dbNamespace))
	})

export const servicePlatform = (
	service: string,
	window: InfraWindow,
	connected: ReadonlySet<string>,
	environment?: string,
) =>
	Effect.gen(function* () {
		const [railway, workers, databases, namespaces] = yield* Effect.all(
			[
				connected.has("railway") ? fleet("railway_services", window) : Effect.succeed(NONE),
				connected.has("cloudflare") ? fleet("cloudflare_workers", window) : Effect.succeed(NONE),
				connected.has("planetscale") ? fleet("planetscale_databases", window) : Effect.succeed(NONE),
				connected.has("planetscale")
					? calledDatabases(service, window)
					: Effect.succeed(new Set<string>()),
			],
			{ concurrency: "unbounded" },
		)
		const inEnvironment = (row: { readonly environment?: string }) =>
			environment === undefined || row.environment === undefined || row.environment === environment
		// A capped fleet read can miss the match, so the section carries the cap instead of claiming completeness.
		const sections: Array<InfraKindSection> = [
			{
				kind: "railway_services",
				rows: railway.rows.filter((row) => row.name === service && inEnvironment(row)),
				truncated: railway.truncated,
			},
			{
				kind: "cloudflare_workers",
				rows: workers.rows.filter((row) => row.name === service),
				truncated: workers.truncated,
			},
			{
				kind: "planetscale_databases",
				rows: databases.rows.filter((row) => namespaces.has(row.name)),
				truncated: databases.truncated,
			},
		]
		return sections.filter((section) => section.rows.length > 0 || section.truncated)
	})
