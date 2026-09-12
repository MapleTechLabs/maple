import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import {
	listAiSessions,
	readAiSessionDetails,
	readAiSessionDistributions,
	readAiSessionFacets,
	readAiSessionSpans,
	readAiSessionSummary,
	readAiToolErrorDetail,
	readAiToolErrorSamples,
	readAiToolErrors,
	readAiToolsBreakdowns,
	readAiToolsSeries,
	readAiToolsTotals,
} from "@/services/ai-sessions/ai-session-reads"

/**
 * Dashboard-only AI agent session reads.
 *
 * Serves the Agent Sessions page (behind the `agent_tracing` org rollout flag).
 * The flag hides the surface, not the data — scoping is `CurrentTenant`, like
 * every other warehouse read.
 *
 * Every handler is the tenant plus one call into
 * `@/services/ai-sessions/ai-session-reads`, which the MCP tools read through
 * as well: the reads, their span annotations and their comments live there.
 */
export const HttpAiSessionsInternalLive = HttpApiBuilder.group(
	MapleInternalApi,
	"aiSessionsInternal",
	(handlers) =>
		handlers
			.handle("list", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* listAiSessions(tenant, payload)
				}),
			)
			.handle("details", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* readAiSessionDetails(tenant, payload)
				}),
			)
			.handle("facets", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* readAiSessionFacets(tenant, payload)
				}),
			)
			.handle("distributions", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* readAiSessionDistributions(tenant, payload)
				}),
			)
			.handle("spans", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* readAiSessionSpans(tenant, payload)
				}),
			)
			.handle("summary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* readAiSessionSummary(tenant, payload)
				}),
			)
			.handle("toolsSeries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* readAiToolsSeries(tenant, payload)
				}),
			)
			.handle("toolsTotals", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* readAiToolsTotals(tenant, payload)
				}),
			)
			.handle("toolsBreakdowns", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* readAiToolsBreakdowns(tenant, payload)
				}),
			)
			.handle("toolErrors", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* readAiToolErrors(tenant, payload)
				}),
			)
			.handle("toolErrorDetail", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* readAiToolErrorDetail(tenant, payload)
				}),
			)
			.handle("toolErrorSamples", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* readAiToolErrorSamples(tenant, payload)
				}),
			),
)
