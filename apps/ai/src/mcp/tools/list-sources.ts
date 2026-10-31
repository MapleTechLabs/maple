import { McpQueryError, type McpToolRegistrar } from "./types"
import { truncate } from "../lib/format"
import { Clock, Effect, Schema } from "effect"
import { ListSourcesOutput } from "@maple/domain/mcp-outputs"
import { SourcePlatform } from "@maple/domain/primitives"
import { SOURCE_HEALTH_STATUSES } from "@maple/domain/source-health"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { SourcesService } from "@maple/backend/services/org/SourcesService"
import { publicSourceId } from "@maple/backend/services/org/integration-sources"

const TOOL = "list_sources"

const RANK = new Map(SOURCE_HEALTH_STATUSES.map((status, index) => [status, index]))

export function registerListSourcesTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "List Sources",
		description:
			"Everything that sends data to this Maple organization, worst health first: OpenTelemetry SDKs and collectors " +
			"(each with its own token, or the default ingest keys), Kubernetes clusters, Docker hosts, Prometheus scrape " +
			"targets and connected integrations (Cloudflare, Google Cloud, Railway, PlanetScale, GitHub CI). Each source " +
			"says whether data is arriving and when it last did. Telemetry carries its source in the `maple_source_id` " +
			"resource attribute, so a source id filters traces, logs and metrics.",
		parameters: Schema.Struct({
			platform: P.optionalOneOf(SourcePlatform.literals, "Only sources of this platform"),
		}),
		output: ListSourcesOutput,
		hints: { readOnly: true },
		phrases: ["Checking sources", "Listing data sources"],
		handler: Effect.fn("McpTool.listSources")(function* ({ platform }) {
			const tenant = yield* CurrentMcpTenant
			const service = yield* SourcesService
			const sources = yield* service
				.list(tenant.orgId)
				.pipe(
					Effect.mapError(
						(error) =>
							new McpQueryError({ message: error.message, pipeName: TOOL, cause: error }),
					),
				)
			const rows = sources
				.filter((source) => platform === undefined || source.platform === platform)
				.map((source) => ({
					id: publicSourceId(source.id),
					name: source.name,
					platform: source.platform,
					kind: source.kind,
					status: source.health.status,
					lastDataAt: source.health.lastDataAt,
					problem: source.health.problem,
					allowedSignals: source.allowedSignals,
				}))
				.sort((a, b) => (RANK.get(a.status) ?? 0) - (RANK.get(b.status) ?? 0))
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.sources.count": rows.length,
				"maple.sources.unhealthy": rows.filter((row) => row.status !== "healthy").length,
			})
			return { generatedAt: new Date(yield* Clock.currentTimeMillis).toISOString(), sources: rows }
		}),
		render: (output) => {
			if (output.sources.length === 0) {
				return {
					title: "Sources",
					empty: {
						message: "No source matches.",
						hints: ["Create one in Sources → Connect source."],
					},
					blocks: [],
				}
			}
			const unhealthyPull = output.sources.some(
				(s) => s.kind === "integration" && s.status !== "healthy",
			)
			return {
				title: "Sources",
				blocks: [
					doc.table(
						["Source", "Platform", "Status", "Last data", "Id", "Problem"],
						output.sources.map((s) => [
							s.kind === "default" ? `${s.name} (default keys)` : s.name,
							s.platform,
							s.status,
							s.lastDataAt ?? "never",
							s.id,
							truncate(s.problem ?? "", 160),
						]),
					),
				],
				next: [
					...(unhealthyPull
						? [
								doc.next(
									"list_integrations",
									{},
									"the failing integration's resources and errors",
								),
							]
						: []),
					doc.next("audit_setup", {}, "instrumentation gaps across the sources"),
				],
			}
		},
	})
}
