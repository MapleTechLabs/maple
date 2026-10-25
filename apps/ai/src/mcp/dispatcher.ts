import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"

import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"
import { SandboxClient } from "@maple/backend/sandbox/client"
import { CloudflareRepoSandboxLive } from "@maple/backend/services/sandbox/CloudflareRepoSandbox"
import type { SandboxError } from "@maple/backend/sandbox/contract"
import { RepoSandboxService, type RepositoryTarget } from "@maple/backend/services/sandbox/RepoSandboxService"

import { AlertsService } from "@maple/backend/services/alerts/AlertsService"

import { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"

import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { ErrorIssueReadModelsService } from "@maple/backend/services/errors/ErrorIssueReadModelsService"
import { ErrorIssueWorkflowService } from "@maple/backend/services/errors/ErrorIssueWorkflowService"
import { ErrorPolicyService } from "@maple/backend/services/errors/ErrorPolicyService"
import { ErrorsService } from "@maple/backend/services/errors/ErrorsService"
import { IssueFixVerificationService } from "@maple/backend/services/errors/IssueFixVerificationService"
import { RecommendationIssueService } from "@maple/backend/services/errors/RecommendationIssueService"

import { PullRequestLookupLive } from "@maple/backend/services/errors/pull-request-lookup-live"

import { SetupAuditService } from "@maple/backend/services/org/SetupAuditService"
import { RailwayMetricsService } from "@maple/backend/services/integrations/RailwayMetricsService"
import { ScrapeTargetsService } from "@maple/backend/services/integrations/ScrapeTargetsService"
import { VcsCommitService } from "@maple/backend/services/integrations/vcs/VcsCommitService"
import { IntegrationInventoryService } from "@maple/backend/services/integrations/IntegrationInventoryService"
import { SourcesService } from "@maple/backend/services/org/SourcesService"
import { AgentFeedbackService } from "@maple/backend/services/feedback/AgentFeedbackService"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { withoutInvocationContext } from "@maple/backend/platform/invocation-context"
import * as Cloudflare from "alchemy/Cloudflare"

// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import type { McpToolNotFoundError } from "@maple/domain/mcp-tool-contract"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import type { McpToolResult } from "./tools/types"
import type { McpToolRuntimeRequirements } from "./tools/runtime-requirements"
import { CurrentMcpRequestTenant, CurrentMcpTenant } from "./lib/query-warehouse"
import { recordExpectedMcpFailure } from "./expected-failures"
import { loadRegistry } from "./tool-catalog"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { recordMcpToolAudit } from "@maple/backend/services/audit/audit-access"

/**
 * How a failure reads to the model: one short lead naming the kind of failure, never an error tag.
 * The category also lands on the span, so failures can be counted by what the model could do.
 */
const failureResult = (text: string, category: string): McpToolResult => ({
	isError: true,
	content: [{ type: "text", text }],
	failureCategory: category,
})

/**
 * Appended to failures that are likely Maple's fault, on the public transport only: an outside
 * agent has the motive and the details to report it right when the call fails. Maple's own
 * agents (chat, bot) are not asked to report on Maple.
 */
export const withFeedbackHint = (text: string, name: string, surface: McpToolSurface): string =>
	surface === "mcp" && name !== "send_maple_feedback"
		? `${text}\nIf this looks like a bug in Maple rather than in your call, offer the user to report it with \`send_maple_feedback\`.`
		: text

/**
 * Real failures leave the dispatcher span through the error channel so it exports as Error; the
 * caller converts them into in-band results outside it. Expected 4xx stay Ok inside the span.
 */
const REAL_FAILURE_CATEGORY = new Map<string, string>([
	["@maple/mcp/errors/McpQueryError", "query"],
	["@maple/mcp/errors/McpTenantError", "tenant"],
	["@maple/mcp/errors/McpAuthUnavailableError", "auth"],
	["@maple/mcp/errors/McpInvalidTenantError", "tenant"],
])

const dispatchInSpan = Effect.fn("McpToolDispatcher.call")(function* (
	name: string,
	input: unknown,
	surface: McpToolSurface,
) {
	// The tool name was a log annotation only, so per-tool attribution worked
	// solely because each handler happens to carry its own `McpTool.<name>` span
	// — every usage query had to reconstruct it with `substring(SpanName, 9)`.
	yield* Effect.annotateCurrentSpan("maple.mcp.tool", name)
	const registry = yield* loadRegistry
	return yield* registry.executeRegisteredMcpToolUnscoped(name, input, surface).pipe(
		Effect.catchTag("@maple/mcp/errors/McpDecodeError", (error) =>
			recordExpectedMcpFailure(error, "Invalid parameters").pipe(
				Effect.as(failureResult(error.message, "invalid_parameters")),
			),
		),
		Effect.catchTags({
			"@maple/mcp/errors/McpInvalidInputError": (error) =>
				recordExpectedMcpFailure(error, "Invalid tool input").pipe(
					Effect.as(
						failureResult(
							[
								`Invalid input${error.parameter === undefined ? "" : ` (\`${error.parameter}\`)`}: ${error.message}`,
								...(error.example === undefined ? [] : [`Example: ${error.example}`]),
							].join("\n"),
							"invalid_input",
						),
					),
				),
			"@maple/mcp/errors/McpNotReadyError": (error) =>
				recordExpectedMcpFailure(error, "Tool dependency not ready").pipe(
					Effect.as(
						failureResult(
							`Not ready yet: ${error.message} Retry in about ${error.retryAfterSeconds}s; gather other evidence meanwhile.`,
							"not_ready",
						),
					),
				),
			"@maple/mcp/errors/McpUnavailableError": (error) =>
				recordExpectedMcpFailure(error, "Tool capability unavailable").pipe(
					Effect.as(
						failureResult(
							`Unavailable: ${error.message} Retrying will not help; use other tools.`,
							"unavailable",
						),
					),
				),
			"@maple/mcp/errors/McpQueryBudgetError": (error) =>
				recordExpectedMcpFailure(error, "Query exceeded its budget").pipe(
					Effect.annotateLogs({
						"maple.mcp.pipe": error.pipeName,
						"maple.mcp.setting": error.setting,
					}),
					Effect.as(failureResult(`Query too expensive: ${error.message}`, "query_budget")),
				),
			// Missing/invalid credentials are expected 401s, not failures: they are
			// recorded on the span as attributes + a Warn log (see
			// `expected-failures.ts`), never as an Error status or exception event.
			"@maple/mcp/errors/McpAuthMissingError": (error) =>
				recordExpectedMcpFailure(error, "MCP authentication failed").pipe(
					Effect.as(failureResult(`Authentication required: ${error.message}`, "auth")),
				),
			"@maple/mcp/errors/McpAuthInvalidError": (error) =>
				recordExpectedMcpFailure(error, "MCP authentication failed").pipe(
					Effect.as(failureResult(`Authentication failed: ${error.message}`, "auth")),
				),
		}),
		// After the catchTags above, so a failure they converted into an in-band
		// `isError` result is still counted. Tool handlers report failure in the
		// result rather than the error channel, so span status alone never
		// reflected a failed tool call.
		Effect.tap((result) =>
			Effect.annotateCurrentSpan({
				"result.isError": result.isError === true,
				"maple.mcp.result.chars": result.content.reduce(
					(total, block) => total + block.text.length,
					0,
				),
				"maple.mcp.result.structured": result.structuredContent !== undefined,
				...(result.failureCategory === undefined
					? undefined
					: { "maple.mcp.error.category": result.failureCategory }),
			}),
		),
		Effect.tapError((error) => {
			const category = REAL_FAILURE_CATEGORY.get(error._tag)
			return category === undefined
				? Effect.void
				: Effect.annotateCurrentSpan({ "result.isError": true, "maple.mcp.error.category": category })
		}),
		Effect.annotateLogs({ "maple.mcp.tool": name }),
	)
})

/** Raw dispatcher. Executable handlers stay private so callers cannot omit the request tenant. */
const callMcpToolUnscoped = (name: string, input: unknown, surface: McpToolSurface) =>
	dispatchInSpan(name, input, surface).pipe(
		Effect.catchTags({
			"@maple/mcp/errors/McpQueryError": (error) =>
				Effect.logError("MCP tool execution failed").pipe(
					Effect.annotateLogs({
						"error.message": error.message,
						"error.type": error._tag,
						"maple.mcp.pipe": error.pipeName,
					}),
					Effect.as(
						failureResult(
							withFeedbackHint(`Query failed: ${error.message}`, name, surface),
							"query",
						),
					),
				),
			"@maple/mcp/errors/McpTenantError": (error) =>
				Effect.logError("MCP tool execution failed").pipe(
					Effect.annotateLogs({ "error.message": error.message, "error.type": error._tag }),
					Effect.as(
						failureResult(
							withFeedbackHint(`Tenant error: ${error.message}`, name, surface),
							"tenant",
						),
					),
				),
			"@maple/mcp/errors/McpAuthUnavailableError": (error) =>
				Effect.logError("MCP authentication dependency failed").pipe(
					Effect.annotateLogs({ "error.message": error.message, "error.type": error._tag }),
					Effect.as(failureResult("Authentication is temporarily unavailable.", "auth")),
				),
			"@maple/mcp/errors/McpInvalidTenantError": (error) =>
				Effect.logError("MCP tenant validation failed").pipe(
					Effect.annotateLogs({
						"error.message": error.message,
						"error.type": error._tag,
						"maple.mcp.field": error.field,
					}),
					Effect.as(failureResult(`Tenant error (${error.field}): ${error.message}`, "tenant")),
				),
		}),
		Effect.annotateLogs({ "maple.mcp.tool": name }),
	)

export interface McpToolExecutorApi {
	readonly execute: (
		tenant: TenantContext,
		name: string,
		input: unknown,
		surface: McpToolSurface,
	) => Effect.Effect<McpToolResult, McpToolNotFoundError>
	/**
	 * Start cloning a repository's commit before any tool asks for it. Not a tool call: nothing
	 * is audited, because nothing the model chose runs.
	 */
	readonly prepareRepository: (
		tenant: TenantContext,
		target: RepositoryTarget,
	) => Effect.Effect<void, SandboxError>
	/**
	 * Warm the org's repositories at their tracked branches when the commit an agent will read is
	 * not known yet. Every checkout shares one mirror per repository, so the deployed commit it
	 * picks later costs a delta fetch. Skipped past a few repositories rather than guessing.
	 */
	readonly prepareConnectedRepositories: (tenant: TenantContext) => Effect.Effect<void>
}

/** More connected repositories than this and an investigation warms none of them. */
const MAX_PREPARED_REPOSITORIES = 3

/**
 * Closed execution boundary for every MCP surface.
 *
 * The layer captures the finite application-service context once. Each call
 * must then supply its authenticated tenant explicitly, so no transport can
 * accidentally execute a raw handler without CurrentMcpTenant.
 */
const McpRuntimeServicesLive = Layer.mergeAll(
	AgentFeedbackService.layer,
	AlertReadModelsService.layer,
	AlertRulesService.layer,
	AlertsService.layer,
	AuditLogService.layer,
	DashboardPersistenceService.layer,
	ErrorActorsService.layer,
	ErrorIssueReadModelsService.layer,
	ErrorIssueWorkflowService.layer,
	ErrorPolicyService.layer,
	ErrorsService.layer,
	IntegrationInventoryService.layer,
	SourcesService.layer,
	IssueFixVerificationService.layer,
	QueryEngineService.layer,
	RailwayMetricsService.layer,
	RecommendationIssueService.layer,
	RepoSandboxService.layer,
	ScrapeTargetsService.layer,
	SetupAuditService.layer,
	VcsCommitService.layer,
	VcsSourceService.layer,
	WarehouseQueryService.layer,
).pipe(
	Layer.provide(
		CloudflareRepoSandboxLive.pipe(
			Layer.provide(Layer.mergeAll(VcsSourceService.layer, SandboxClient.layer)),
		),
	),
	Layer.provide(PullRequestLookupLive),
	Layer.provide(FetchHttpClient.layer),
)

export class McpToolExecutor extends Context.Service<McpToolExecutor, McpToolExecutorApi>()(
	"@maple/ai/mcp/McpToolExecutor",
	{
		make: Effect.gen(function* () {
			// Provided on every later call, so it must not carry this build's request (its Postgres
			// scope, Scope, span or tenant): those would override the calling request's own.
			const runtimeServices = Context.omit(
				CurrentMcpRequestTenant,
				CurrentMcpTenant,
				Cloudflare.WorkerExecutionContext,
			)(withoutInvocationContext(yield* Effect.context<McpToolRuntimeRequirements>()))
			const sandbox = yield* RepoSandboxService
			const source = yield* VcsSourceService

			const execute = Effect.fn("McpToolExecutor.execute")(function* (
				tenant: TenantContext,
				name: string,
				input: unknown,
				surface: McpToolSurface,
			) {
				yield* Effect.annotateCurrentSpan({
					"maple.mcp.tool": name,
					"maple.mcp.surface": surface,
				})
				const result = yield* callMcpToolUnscoped(name, input, surface).pipe(
					Effect.provideService(CurrentMcpTenant, tenant),
					Effect.provide(runtimeServices),
				)
				// Every tool call is a read of (or change to) org data; the entry
				// carries the tool, its parameters, and whether it failed in-band.
				yield* recordMcpToolAudit({
					tenant,
					name,
					input,
					surface,
					isError: result.isError === true,
				}).pipe(Effect.provide(runtimeServices))
				return result
			})

			const prepareRepository = Effect.fn("McpToolExecutor.prepareRepository")(function* (
				tenant: TenantContext,
				target: RepositoryTarget,
			) {
				yield* Effect.annotateCurrentSpan({ "vcs.repository.full_name": target.repository })
				yield* sandbox.prepare(tenant.orgId, target)
			})

			const prepareConnectedRepositories = Effect.fn("McpToolExecutor.prepareConnectedRepositories")(
				function* (tenant: TenantContext) {
					const repositories = (yield* source.listRepositories(tenant.orgId)).filter(
						(repository) => !repository.isArchived,
					)
					yield* Effect.annotateCurrentSpan("vcs.repository.count", repositories.length)
					if (repositories.length > MAX_PREPARED_REPOSITORIES) return
					yield* Effect.forEach(
						repositories,
						(repository) =>
							prepareRepository(tenant, { repository: repository.fullName }).pipe(
								Effect.catch((error) =>
									Effect.logInfo("Could not prepare a repository checkout").pipe(
										Effect.annotateLogs({
											"vcs.repository.full_name": repository.fullName,
											error: error.message,
										}),
									),
								),
							),
						{ concurrency: "unbounded", discard: true },
					)
				},
				Effect.catch((error) =>
					Effect.logInfo("Could not list repositories to prepare").pipe(
						Effect.annotateLogs({ error: error.message }),
					),
				),
			)

			return { execute, prepareRepository, prepareConnectedRepositories }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(McpRuntimeServicesLive))
}
