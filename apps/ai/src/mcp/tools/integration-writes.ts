/**
 * The integration changes an agent may make: poll Railway now, and manage plain Prometheus scrape
 * targets. Both are admin-only, like their HTTP routes. Connecting a provider stays in Settings:
 * it needs an OAuth consent or a pasted token. Scrape credentials stay there too, so no secret
 * passes through a model.
 */
import { Clock, Effect, Schema } from "effect"
import {
	DeleteScrapeTargetOutput,
	ScrapeTargetMutationOutput,
	SyncRailwayOutput,
} from "@maple/domain/mcp-outputs"
import { CreateScrapeTargetRequest, UpdateScrapeTargetRequest } from "@maple/domain/http"
import { decodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { ScrapeIntervalSeconds } from "@maple/domain/primitives"
import { redactUrlSecrets } from "@maple/domain/url-redaction"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import { RailwayMetricsService } from "@maple/backend/services/integrations/RailwayMetricsService"
import { ScrapeTargetsService } from "@maple/backend/services/integrations/ScrapeTargetsService"
import { McpInvalidInputError, McpQueryError, McpUnavailableError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

/** The Railway poller ticks every 5 minutes; this long without a success after a sync is not a blip. */
const RAILWAY_STALE_MS = 30 * 60 * 1000

const adminOnly = (tool: string) =>
	Effect.gen(function* () {
		const tenant = yield* CurrentMcpTenant
		yield* requireAdmin(
			tenant.roles,
			() =>
				new McpUnavailableError({
					message: `${tool} changes the organization's integrations, which only org admins may do. Ask an admin, or change it in Sources.`,
					capability: "org_admin",
				}),
		)
		return tenant
	})

const queryError = (tool: string) => (error: { readonly _tag: string; readonly message: string }) =>
	new McpQueryError({ message: `${error._tag}: ${error.message}`, pipeName: tool, cause: error })

const INTERVAL = Schema.Int.check(Schema.isGreaterThanOrEqualTo(5), Schema.isLessThanOrEqualTo(300))
const decodeInterval = Schema.decodeUnknownEffect(ScrapeIntervalSeconds)

const intervalParam = (description: string) =>
	Schema.optional(INTERVAL).annotate({ description: `${description} (5 to 300 seconds)` })

type TargetRow = typeof ScrapeTargetMutationOutput.Type.target

const toRow = (target: {
	readonly id: string
	readonly name: string
	readonly url: string
	readonly serviceName: string | null
	readonly scrapeIntervalSeconds: number
	readonly enabled: boolean
	readonly authType: string
	readonly lastScrapeAt: string | null
	readonly lastScrapeError: string | null
}): TargetRow => ({
	id: target.id,
	name: target.name,
	// Scheme, host and path only: a Settings-created URL may carry a token in its userinfo or query.
	url: redactUrlSecrets(target.url),
	serviceName: target.serviceName,
	scrapeIntervalSeconds: target.scrapeIntervalSeconds,
	enabled: target.enabled,
	authType: target.authType,
	lastScrapeAt: target.lastScrapeAt,
	lastScrapeError: target.lastScrapeError,
})

/** A user-created target by id or exact name. Integration-managed targets are edited by their integration. */
const resolveTarget = (
	tool: string,
	orgId: Parameters<ScrapeTargetsService["Service"]["list"]>[0],
	ref: string,
) =>
	Effect.gen(function* () {
		const targets = yield* ScrapeTargetsService.pipe(
			Effect.flatMap((service) => service.list(orgId)),
			Effect.mapError(queryError(tool)),
		)
		// The REST id (scrp_…) names the same target as its UUID.
		const id = decodePublicId(PublicIdPrefixes.scrapeTarget, ref) ?? ref
		const matches = targets.targets.filter((target) => target.id === id || target.name === ref)
		const [target] = matches
		if (target === undefined) {
			return yield* new McpInvalidInputError({
				message: `No scrape target named "${ref}". list_integrations provider=prometheus lists them.`,
				parameter: "target",
			})
		}
		if (matches.length > 1) {
			return yield* new McpInvalidInputError({
				message: `${matches.length} scrape targets are named "${ref}"; pass one's id instead: ${matches.map((m) => m.id).join(", ")}.`,
				parameter: "target",
			})
		}
		if (target.managedBy !== null) {
			return yield* new McpInvalidInputError({
				message: `"${target.name}" is managed by the ${target.managedBy.split(":")[0]} integration; change it from that integration in Sources.`,
				parameter: "target",
			})
		}
		return target
	})

const renderTarget = (title: string, target: TargetRow) => ({
	title,
	notices: target.enabled
		? []
		: [
				"Scraping is paused: nothing is scraped and no new errors are recorded. Its stored metrics stay; update_scrape_target enabled=true resumes it.",
			],
	blocks: [
		doc.fields([
			["Name", target.name],
			["Id", target.id],
			["URL", target.url],
			["Service", target.serviceName ?? undefined],
			["Interval", `${target.scrapeIntervalSeconds}s`],
			["Enabled", target.enabled ? "yes" : "no"],
			["Auth", target.authType],
			["Last scrape", target.lastScrapeAt ?? "not yet"],
			[
				target.enabled ? "Last error" : "Last error (before the pause)",
				target.lastScrapeError ?? undefined,
			],
		]),
	],
	next: target.enabled
		? [
				doc.next(
					"list_integrations",
					{ provider: "prometheus" },
					"every scrape target's status after the next scrape",
				),
			]
		: [],
})

export function registerIntegrationWriteTools(server: McpToolRegistrar) {
	server.define({
		name: "sync_railway",
		title: "Sync Railway",
		description:
			"Poll Railway now instead of waiting for the next 5-minute tick, then report each environment's last sync and error. Use after fixing a Railway token or project access, to confirm metrics flow again. Admin only. Environments already caught up cost no Railway call.",
		parameters: Schema.Struct({}),
		output: SyncRailwayOutput,
		hints: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
		phrases: ["Syncing Railway"],
		handler: Effect.fn("McpTool.syncRailway")(function* () {
			const tenant = yield* adminOnly("sync_railway")
			const railway = yield* RailwayMetricsService
			const status = yield* railway.sync(tenant.orgId).pipe(Effect.mapError(queryError("sync_railway")))
			const now = yield* Clock.currentTimeMillis
			return {
				connected: status.connected,
				authFailed: status.authFailed,
				lastSyncedAt: iso(status.lastSyncedAt),
				lastError: status.lastError,
				environments: status.environments
					.filter((env) => env.enabled)
					.map((env) => ({
						project: env.projectName,
						environment: env.environmentName,
						services: env.serviceCount,
						lastSyncedAt: iso(env.lastSyncedAt),
						lastError: env.lastError,
						stale: env.lastSyncedAt === null || now - env.lastSyncedAt > RAILWAY_STALE_MS,
					})),
			}
		}),
		render: (output) =>
			!output.connected
				? {
						title: "Sync Railway",
						empty: {
							message: "Railway is not connected. Connect it with an API token in Sources.",
						},
						blocks: [],
					}
				: {
						title: "Sync Railway",
						notices: [
							...(output.authFailed
								? [
										"Railway rejected the stored token, so nothing was polled. Save a new token in Sources.",
									]
								: []),
							...output.environments
								.filter((env) => env.stale && env.lastError === null)
								.map(
									(env) =>
										`The poll ran, but ${env.project} / ${env.environment} still has no new data: Railway returned nothing for it. The token most likely lost access to that project or environment, or its services stopped. Check it in Railway, then save a token with access in Sources.`,
								),
						],
						blocks: [
							doc.fields([
								["Last sync", output.lastSyncedAt ?? "never"],
								["Last error", output.lastError ?? undefined],
							]),
							doc.table(
								["Project / environment", "Services", "Status", "Last success", "Error"],
								output.environments.map((env) => [
									`${env.project} / ${env.environment}`,
									String(env.services),
									env.lastError !== null
										? "failing"
										: env.stale
											? "stale after sync"
											: "fresh",
									env.lastSyncedAt ?? "never",
									env.lastError ?? "—",
								]),
							),
						],
						next: [
							doc.next(
								"list_infra",
								{ kind: "railway_services" },
								"the services' CPU and memory once the poll lands",
							),
						],
					},
	})

	server.define({
		name: "create_scrape_target",
		title: "Create Scrape Target",
		description:
			"Start scraping a Prometheus metrics endpoint: Maple's scraper pulls `url` every interval and stores the samples as metrics, tagged with `service` when given. Admin only. The endpoint must be reachable from the internet without credentials; to add a bearer or basic credential, create it in Sources → Prometheus instead.",
		parameters: Schema.Struct({
			name: P.text("A label for the target, e.g. `node-exporter`"),
			url: P.text("The full metrics URL, e.g. `https://metrics.example.com/metrics`"),
			service: P.service("The `service.name` its metrics belong to"),
			interval_seconds: intervalParam("How often to scrape, default 15"),
		}),
		aliases: P.SERVICE_ALIASES,
		output: ScrapeTargetMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
		phrases: ["Adding a scrape target"],
		handler: Effect.fn("McpTool.createScrapeTarget")(function* (params) {
			const tenant = yield* adminOnly("create_scrape_target")
			const targets = yield* ScrapeTargetsService
			const interval =
				params.interval_seconds === undefined
					? undefined
					: yield* decodeInterval(params.interval_seconds).pipe(
							Effect.mapError(
								() =>
									new McpInvalidInputError({
										message: "interval_seconds must be 5 to 300.",
										parameter: "interval_seconds",
									}),
							),
						)
			const created = yield* targets
				.create(
					tenant.orgId,
					new CreateScrapeTargetRequest({
						name: params.name,
						url: params.url,
						targetType: "prometheus",
						authType: "none",
						...(params.service === undefined ? undefined : { serviceName: params.service }),
						...(interval === undefined ? undefined : { scrapeIntervalSeconds: interval }),
					}),
				)
				.pipe(
					Effect.catchTag("@maple/http/errors/ScrapeTargetValidationError", (error) =>
						Effect.fail(new McpInvalidInputError({ message: error.message, parameter: "url" })),
					),
					Effect.mapError((error) =>
						error instanceof McpInvalidInputError
							? error
							: queryError("create_scrape_target")(error),
					),
				)
			return { action: "created" as const, target: toRow(created) }
		}),
		render: (output) => renderTarget(`Scrape target ${output.action}`, output.target),
	})

	server.define({
		name: "update_scrape_target",
		title: "Update Scrape Target",
		description:
			"Change a Prometheus scrape target: pause or resume it, or change its URL, name, service or interval. Fields left out keep their value, and a stored credential is kept. Admin only. Targets managed by an integration (PlanetScale) are changed from that integration in Settings.",
		parameters: Schema.Struct({
			target: P.text("The target's name or id (list_integrations provider=prometheus lists them)"),
			enabled: P.optionalFlag("false pauses scraping, true resumes it"),
			url: P.optionalText("A new metrics URL"),
			name: P.optionalText("A new name"),
			service: P.service("A new `service.name` for its metrics"),
			interval_seconds: intervalParam("A new scrape interval"),
		}),
		aliases: P.SERVICE_ALIASES,
		output: ScrapeTargetMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
		phrases: ["Updating a scrape target"],
		handler: Effect.fn("McpTool.updateScrapeTarget")(function* (params) {
			const tenant = yield* adminOnly("update_scrape_target")
			const targets = yield* ScrapeTargetsService
			const target = yield* resolveTarget("update_scrape_target", tenant.orgId, params.target)
			const interval =
				params.interval_seconds === undefined
					? undefined
					: yield* decodeInterval(params.interval_seconds).pipe(
							Effect.mapError(
								() =>
									new McpInvalidInputError({
										message: "interval_seconds must be 5 to 300.",
										parameter: "interval_seconds",
									}),
							),
						)
			const updated = yield* targets
				.update(
					tenant.orgId,
					target.id,
					new UpdateScrapeTargetRequest({
						...(params.enabled === undefined ? undefined : { enabled: params.enabled }),
						...(params.url === undefined ? undefined : { url: params.url }),
						...(params.name === undefined ? undefined : { name: params.name }),
						...(params.service === undefined ? undefined : { serviceName: params.service }),
						...(interval === undefined ? undefined : { scrapeIntervalSeconds: interval }),
					}),
				)
				.pipe(
					Effect.catchTag("@maple/http/errors/ScrapeTargetValidationError", (error) =>
						Effect.fail(new McpInvalidInputError({ message: error.message })),
					),
					Effect.mapError((error) =>
						error instanceof McpInvalidInputError
							? error
							: queryError("update_scrape_target")(error),
					),
				)
			return { action: "updated" as const, target: toRow(updated) }
		}),
		render: (output) => renderTarget(`Scrape target ${output.action}`, output.target),
	})

	server.define({
		name: "delete_scrape_target",
		title: "Delete Scrape Target",
		description:
			"Stop scraping a Prometheus target and delete it with its check history; metrics already stored stay. Irreversible; requires confirm=true. To stop it for a while, update_scrape_target enabled=false instead. Admin only.",
		parameters: Schema.Struct({
			target: P.text("The target's name or id"),
			confirm: P.flag("Must be true. There is no undo."),
		}),
		output: DeleteScrapeTargetOutput,
		hints: { readOnly: false, destructive: true, idempotent: false },
		phrases: ["Deleting a scrape target"],
		handler: Effect.fn("McpTool.deleteScrapeTarget")(function* (params) {
			if (params.confirm !== true) {
				return yield* new McpInvalidInputError({
					message: `Deletion not confirmed. Re-call delete_scrape_target with confirm=true to delete "${params.target}", or pause it with update_scrape_target enabled=false.`,
					parameter: "confirm",
				})
			}
			const tenant = yield* adminOnly("delete_scrape_target")
			const targets = yield* ScrapeTargetsService
			const target = yield* resolveTarget("delete_scrape_target", tenant.orgId, params.target)
			yield* targets
				.delete(tenant.orgId, target.id)
				.pipe(Effect.mapError(queryError("delete_scrape_target")))
			return { deleted: true, id: target.id, name: target.name }
		}),
		render: (output) => ({
			title: "Scrape target deleted",
			blocks: [doc.text(`Deleted "${output.name}" (${output.id}). Its stored metrics remain.`)],
		}),
	})
}
