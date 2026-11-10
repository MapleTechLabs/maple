import { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"
import type { SandboxError } from "@maple/backend/sandbox/contract"
import { RepoSandboxService, type RepositoryTarget } from "@maple/backend/services/sandbox/RepoSandboxService"
import { ExternalDataSourceService } from "@maple/backend/services/data-sources/ExternalDataSourceService"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import type { DataSourcePersistenceError, ExternalDataSourceDocument } from "@maple/domain/data-sources"
import { withoutInvocationContext } from "@maple/backend/platform/invocation-context"
import * as Cloudflare from "@alchemy.run/cloudflare"

// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import type { McpToolNotFoundError } from "@maple/domain/mcp-tool-contract"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import { Context, Effect, Layer, Array as Arr } from "effect"
import { FEEDBACK_TOOL, type McpToolResult } from "./tools/types"
import { McpRuntimeServicesLive, type McpToolRuntimeRequirements } from "./tools/runtime-services"
import { CurrentMcpRequestTenant, CurrentMcpTenant } from "./tenant"
import { recordExpectedMcpFailure, spanFailureMessage } from "./expected-failures"
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
 * agent has the motive and the details to report it right when the call fails. "Offer the user"
 * was read literally and no report was ever sent, so the agent sends it itself. Maple's own
 * agents (chat, bot) are not asked to report on Maple.
 */
export const withFeedbackHint = (text: string, name: string, surface: McpToolSurface): string =>
	surface === "mcp" && name !== FEEDBACK_TOOL
		? `${text}\nIf this looks like a bug in Maple rather than in your call, report it now with \`${FEEDBACK_TOOL}\` (kind "bug", related_to "${name}", what you called and what came back, no user data), then tell the user in one line that you did.`
		: text

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
							Arr.join(
								[
									`Invalid input${error.parameter === undefined ? "" : ` (\`${error.parameter}\`)`}: ${error.message}`,
									...(error.example === undefined ? [] : [`Example: ${error.example}`]),
								],
								"\n",
							),
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
			// A credential that is valid but may not do this is a permission answer, not a bug. An
			// expected 401: span attributes and a Warn log, never an Error status.
			"@maple/mcp/errors/McpAuthInvalidError": (error) =>
				recordExpectedMcpFailure(error, "MCP authentication failed").pipe(
					Effect.as(
						error.reason === "insufficient_scope"
							? failureResult(`Permission denied: ${error.message}`, "permission")
							: failureResult(`Authentication failed: ${error.message}`, "auth"),
					),
				),
		}),
		// After the catchTags above, so a failure they converted into an in-band
		// `isError` result is still counted. Tool handlers report failure in the
		// result rather than the error channel, so span status alone never
		// reflected a failed tool call.
		Effect.tap((result) =>
			Effect.annotateCurrentSpan({
				"result.isError": result.isError === true,
				"maple.mcp.result.chars": Arr.reduce(
					result.content,
					0,
					(total, block) => total + block.text.length,
				),
				"maple.mcp.result.structured": result.structuredContent !== undefined,
				...(result.failureCategory === undefined
					? undefined
					: { "maple.mcp.error.category": result.failureCategory }),
			}),
		),
		// A real failure leaves the span through the error channel so it exports as Error; the caller
		// converts it into an in-band result outside the span. Expected 4xx stay Ok inside it.
		Effect.tapErrorTag("@maple/mcp/errors/McpQueryError", (error) =>
			Effect.annotateCurrentSpan({
				"result.isError": true,
				"maple.mcp.error.category": "query",
				// As expected failures record it: a tool's failure reasons are one query, not a log join.
				"maple.mcp.error.message": spanFailureMessage(error.message),
			}),
		),
		Effect.annotateLogs({ "maple.mcp.tool": name }),
	)
})

/** Raw dispatcher. Executable handlers stay private so callers cannot omit the request tenant. */
const callMcpToolUnscoped = (name: string, input: unknown, surface: McpToolSurface) =>
	dispatchInSpan(name, input, surface).pipe(
		Effect.catchTag("@maple/mcp/errors/McpQueryError", (error) =>
			Effect.logError("MCP tool execution failed").pipe(
				Effect.annotateLogs({
					"error.message": error.message,
					"error.type": error._tag,
					"maple.mcp.pipe": error.pipeName,
				}),
				Effect.as(
					failureResult(withFeedbackHint(`Query failed: ${error.message}`, name, surface), "query"),
				),
			),
		),
		Effect.annotateLogs({ "maple.mcp.tool": name }),
	)

export interface McpToolExecutorApi {
	// BOUNDARY: tool input is unparsed until the tool's own schema decodes it.
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
	/** The org's data sources an agent may query, for prompts and resources. Not a tool call. */
	readonly listDataSources: (
		tenant: TenantContext,
	) => Effect.Effect<ReadonlyArray<ExternalDataSourceDocument>, DataSourcePersistenceError>
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
export class McpToolExecutor extends Context.Service<McpToolExecutor, McpToolExecutorApi>()(
	"@maple/ai/mcp/McpToolExecutor",
	{
		make: Effect.gen(function* () {
			// Provided on every later call, so it must not carry this build's request (its Postgres
			// scope, Scope, span or tenant): those would override the calling request's own.
			const buildContext = yield* Effect.context<McpToolRuntimeRequirements>()
			const runtimeServices = Context.omit(
				CurrentMcpRequestTenant,
				CurrentMcpTenant,
				Cloudflare.WorkerExecutionContext,
			)(withoutInvocationContext(buildContext))
			const sandbox = yield* RepoSandboxService
			const source = yield* VcsSourceService
			const dataSources = yield* ExternalDataSourceService
			const featureFlags = yield* OrganizationFeatureFlagsService

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
					const connected = yield* source.listRepositories(tenant.orgId)
					const repositories = Arr.filter(connected, (repository) => !repository.isArchived)
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

			// An org outside the `dataSources` rollout has none, so prompts and resources never mention them.
			const listDataSources = Effect.fn("McpToolExecutor.listDataSources")(function* (
				tenant: TenantContext,
			) {
				const flags = yield* featureFlags.flags(tenant.orgId)
				if (!flags.dataSources) return []
				return yield* dataSources.list(tenant.orgId, { agent: true })
			})

			return { execute, prepareRepository, prepareConnectedRepositories, listDataSources }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(McpRuntimeServicesLive))
}
