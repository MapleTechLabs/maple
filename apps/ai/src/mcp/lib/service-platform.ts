/**
 * The connected-platform entities behind one service: the Railway service or Cloudflare Worker that
 * shares its name, and the PlanetScale databases its spans call. Matching is by exact name, the
 * only join these integrations share with traces.
 */
import type { InfraKindSection } from "@maple/domain/mcp-outputs"
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
		Effect.map(({ section }) => section.rows),
	)

/** Databases the service's spans called (`db.namespace`), from the service-map edges. */
const calledDatabases = (service: string, window: InfraWindow) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const rows = yield* executor.compiledQuery(
			CH.compile(CH.serviceDbEdgesForServiceQuery({ serviceName: service }), {
				orgId: executor.orgId,
				startTime: window.startTime,
				endTime: window.endTime,
			}),
			{ profile: "aggregation", context: "servicePlatformDbEdges" },
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
				connected.has("railway") ? fleet("railway_services", window) : Effect.succeed([]),
				connected.has("cloudflare") ? fleet("cloudflare_workers", window) : Effect.succeed([]),
				connected.has("planetscale") ? fleet("planetscale_databases", window) : Effect.succeed([]),
				connected.has("planetscale")
					? calledDatabases(service, window)
					: Effect.succeed(new Set<string>()),
			],
			{ concurrency: "unbounded" },
		)
		const inEnvironment = (row: { readonly environment?: string }) =>
			environment === undefined || row.environment === undefined || row.environment === environment
		const sections: Array<InfraKindSection> = [
			{
				kind: "railway_services",
				rows: railway.filter((row) => row.name === service && inEnvironment(row)),
				truncated: false,
			},
			{
				kind: "cloudflare_workers",
				rows: workers.filter((row) => row.name === service),
				truncated: false,
			},
			{
				kind: "planetscale_databases",
				rows: databases.filter((row) => namespaces.has(row.name)),
				truncated: false,
			},
		]
		return sections.filter((section) => section.rows.length > 0)
	})
