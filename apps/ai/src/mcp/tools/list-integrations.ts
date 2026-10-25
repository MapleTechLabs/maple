import { McpQueryError, type McpToolRegistrar } from "./types"
import { truncate } from "../lib/format"
import { Clock, Effect, Schema } from "effect"
import { ListIntegrationsOutput } from "@maple/domain/mcp-outputs"
import { INTEGRATION_PROVIDERS, type IntegrationInventory } from "@maple/domain/integration-inventory"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc, type NextCall } from "../lib/tool-doc"
import { IntegrationInventoryService } from "@maple/backend/services/integrations/IntegrationInventoryService"

const TOOL = "list_integrations"

/** Resources kept per provider in the overview: the worst ones, enough to name the problem. */
const OVERVIEW_RESOURCES = 5
/** Resources kept for one provider: a large Cloudflare account has hundreds of zones. */
const PROVIDER_RESOURCES = 200

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

type Output = typeof ListIntegrationsOutput.Type

/** Providers whose data `list_infra` reads. */
const PLATFORM_PROVIDERS: ReadonlySet<string> = new Set(["cloudflare", "railway", "planetscale"])

/** Where each provider's data is read next, once the integration is known to deliver it. */
const nextFor = (integration: Output["integrations"][number]): ReadonlyArray<NextCall> => {
	switch (integration.provider) {
		case "github":
			return [
				doc.next("list_source_repositories", {}, "the repositories source tools can read"),
				...(integration.feeds.some((feed) => feed.startsWith("GitHub Actions"))
					? [doc.next("ci_runs", {}, "recent workflow runs, failures and durations")]
					: []),
			]
		case "prometheus":
			return [doc.next("list_metrics", {}, "the metrics scrape targets deliver")]
		case "cloudflare":
			return [
				doc.next(
					"list_infra",
					{ kind: "cloudflare_zones" },
					"zone traffic, 5xx rate, cache hits and latency",
				),
				doc.next(
					"list_infra",
					{ kind: "cloudflare_workers" },
					"Worker invocations, errors and CPU time",
				),
			]
		case "railway":
			return [
				doc.next(
					"list_infra",
					{ kind: "railway_services" },
					"Railway services against their CPU and memory limits",
				),
			]
		case "planetscale":
			return [
				doc.next(
					"list_infra",
					{ kind: "planetscale_databases" },
					"database CPU, memory, storage and replica lag",
				),
			]
		case "chat":
			return []
	}
}

export function registerListIntegrationsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "List Integrations",
		description:
			"Every third-party integration connected to this Maple organization (GitHub, Cloudflare, Railway, PlanetScale, " +
			"Prometheus scrape targets, chat workspaces), what Maple data each one feeds, and whether it is working: " +
			"revoked grants, failing or stale pollers, repositories that do not sync, scrape targets that error. Each " +
			"provider lists its resources (repositories, zones, Workers, Logpush jobs, Hyperdrive configs, Railway " +
			"environments, databases, scrape targets) worst first. Answers 'what is connected' and 'why is my Cloudflare / " +
			"Railway / PlanetScale data missing'. Read from Maple's own state, so it never calls the providers.",
		parameters: Schema.Struct({
			provider: P.optionalOneOf(
				INTEGRATION_PROVIDERS,
				"Only this provider, with all of its resources. Omit for every provider with its worst resources",
			),
		}),
		output: ListIntegrationsOutput,
		hints: { readOnly: true },
		phrases: ["Checking integrations", "Listing connected integrations"],
		handler: Effect.fn("McpTool.listIntegrations")(function* ({ provider }) {
			const tenant = yield* CurrentMcpTenant
			const service = yield* IntegrationInventoryService
			const inventory = yield* service
				.list(tenant.orgId)
				.pipe(
					Effect.mapError(
						(error) =>
							new McpQueryError({ message: error.message, pipeName: TOOL, cause: error }),
					),
				)
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.integrations.connected": inventory.integrations.length,
				"maple.integrations.unhealthy": inventory.integrations.filter((i) => i.status !== "healthy")
					.length,
			})
			return toStructured(inventory, provider, yield* Clock.currentTimeMillis)
		}),
		render: (output) => {
			const filter = output.providerFilter
			if (output.integrations.length === 0) {
				const available = output.available.filter(
					(a) => filter === undefined || a.provider === filter,
				)
				return {
					title: "Integrations",
					empty: {
						message:
							filter === undefined
								? "No integration is connected to this organization."
								: `${filter} is not connected to this organization.`,
						hints: [
							filter === undefined
								? "Connect data integrations in Sources, chat and alert connectors in Settings → Integrations. Each feeds:"
								: filter === "chat"
									? "Connect it in Settings → Integrations. Each feeds:"
									: "Connect it in Sources. Each feeds:",
							...available.map((a) => `${a.provider}: ${a.feeds.join("; ")}`),
						],
					},
					blocks: [],
				}
			}
			const unhealthy = output.integrations.filter((i) => i.status !== "healthy")
			const resourceTable = (integration: Output["integrations"][number]) =>
				doc.table(
					["Kind", "Name", "Status", "Last success", "Error / note"],
					integration.resources.map((r) => [
						r.kind,
						r.name,
						r.status,
						r.lastSuccessAt ?? "",
						truncate(r.lastError ?? r.note ?? "", 160),
					]),
				)
			const blocks =
				filter === undefined
					? [
							doc.table(
								["Provider", "Status", "Account", "Unhealthy", "Problem"],
								output.integrations.map((i) => [
									i.provider,
									i.status,
									i.account ?? "",
									`${i.unhealthyCount} of ${i.resourceCount}`,
									truncate(i.problem ?? "", 200),
								]),
							),
							...unhealthy.flatMap((i) =>
								i.resources.some((r) => r.status !== "healthy")
									? [doc.heading(`${i.provider}: worst resources`), resourceTable(i)]
									: [],
							),
							...(output.available.length === 0
								? []
								: [
										doc.text(
											`Not connected: ${output.available.map((a) => a.provider).join(", ")}.`,
										),
									]),
							doc.text(
								"Only resources with a problem are listed. `list_integrations provider=<name>` lists every resource of one provider, with the tools that read its data.",
							),
						]
					: output.integrations.flatMap((i) => [
							doc.fields([
								["Status", i.status],
								["Account", i.account ?? undefined],
								["Connected", i.connectedAt ?? undefined],
								["Problem", i.problem ?? undefined],
								["Feeds", i.feeds.join("; ")],
							]),
							...(i.resources.length === 0 ? [] : [resourceTable(i)]),
						])
			const shown = output.integrations.reduce((n, i) => n + i.resources.length, 0)
			const total = output.integrations.reduce((n, i) => n + i.resourceCount, 0)
			return {
				title: filter === undefined ? "Integrations" : `Integration: ${filter}`,
				blocks,
				...(filter !== undefined && shown < total
					? { truncation: { shown, total, noun: "resources" } }
					: undefined),
				// The overview stays short: the audit, drill-downs where problems were cut off, and one
				// way into the platform data. A single provider gets the calls that read its data.
				next:
					filter === undefined
						? [
								...(unhealthy.length > 0
									? [
											doc.next(
												"audit_setup",
												{},
												"the rest of the setup checks, with fix hints",
											),
										]
									: []),
								...unhealthy
									.filter((i) => i.resources.length >= OVERVIEW_RESOURCES)
									.map((i) =>
										doc.next(
											TOOL,
											{ provider: i.provider },
											`every ${i.provider} resource`,
										),
									),
								...(output.integrations.some((i) => PLATFORM_PROVIDERS.has(i.provider))
									? [
											doc.next(
												"list_infra",
												{},
												"what the connected platforms report: zones, Workers, Railway services, databases",
											),
										]
									: []),
							]
						: output.integrations.flatMap(nextFor),
			}
		},
	})
}

const toStructured = (
	inventory: IntegrationInventory,
	provider: (typeof INTEGRATION_PROVIDERS)[number] | undefined,
	now: number,
): Output => {
	const cap = provider === undefined ? OVERVIEW_RESOURCES : PROVIDER_RESOURCES
	return {
		generatedAt: new Date(now).toISOString(),
		integrations: inventory.integrations
			.filter((i) => provider === undefined || i.provider === provider)
			.map((i) => ({
				provider: i.provider,
				status: i.status,
				account: i.account,
				connectedAt: iso(i.connectedAt),
				problem: i.problem,
				feeds: i.feeds,
				// The overview only needs the resources that explain a problem.
				resources: i.resources
					.filter((r) => provider !== undefined || r.status !== "healthy")
					.slice(0, cap)
					.map((r) => ({
						kind: r.kind,
						name: r.name,
						status: r.status,
						lastSuccessAt: iso(r.lastSuccessAt),
						lastError: r.lastError,
						note: r.note,
					})),
				resourceCount: i.resources.length,
				unhealthyCount: i.resources.filter((r) => r.status !== "healthy").length,
			})),
		available: inventory.available.map((a) => ({ provider: a.provider, feeds: a.feeds })),
		...(provider === undefined ? undefined : { providerFilter: provider }),
	}
}
