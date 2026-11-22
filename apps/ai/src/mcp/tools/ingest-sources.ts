/**
 * Changes to an ingest source: pause or resume it, rename it, limit what its token may send, or
 * delete it. Engineers and admins only, like the REST routes. Creating a source and rolling its
 * token stay in Sources: both show the token once, and no secret passes through a model.
 */
import { Effect, Schema, Array as Arr } from "effect"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { SourceSignal, type OrgId } from "@maple/primitives"
import { type Source, UpdateSourceRequest } from "@maple/domain/http"
import type { SourceConfigRow } from "@maple/domain/mcp-outputs"
import { SourcesService } from "@maple/backend/services/org/SourcesService"
import { publicSourceId } from "@maple/backend/services/integrations/integration-sources"
import { McpInvalidInputError, McpQueryError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../tenant"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { toolAudit } from "../lib/tool-audit"

const TOOL = "manage_ingest_source"

const decodeUpdate = Schema.decodeEffect(UpdateSourceRequest)

/** A refused change says why in the service's words; anything else is a failed write. */
const toMcpSourceError = (error: {
	readonly _tag: string
	readonly message: string
}): McpInvalidInputError | McpQueryError =>
	error._tag === "@maple/http/errors/SourceValidationError" ||
	error._tag === "@maple/http/errors/SourceNotFoundError"
		? new McpInvalidInputError({ message: error.message, parameter: "source" })
		: new McpQueryError({ message: error.message, pipeName: TOOL, cause: error })

/** A source by its `src_…` id or exact name, as list_ingest_sources shows them. */
const resolveSource = (orgId: OrgId, ref: string) =>
	Effect.gen(function* () {
		const sources = yield* SourcesService.pipe(
			Effect.flatMap((service) => service.list(orgId)),
			Effect.mapError(toMcpSourceError),
		)
		// An id wins over a name, so the id a list printed never collides with a source named like it.
		const byId = Arr.filter(sources, (source) => publicSourceId(source.id) === ref || source.id === ref)
		const matches = byId.length > 0 ? byId : Arr.filter(sources, (source) => source.name === ref)
		const [source] = matches
		if (source === undefined) {
			return yield* new McpInvalidInputError({
				message: `No ingest source named "${ref}". list_ingest_sources lists them with their ids.`,
				parameter: "source",
			})
		}
		if (matches.length > 1) {
			return yield* new McpInvalidInputError({
				message: `${matches.length} ingest sources are named "${ref}"; pass one's id instead: ${Arr.join(
					Arr.map(matches, (match) => publicSourceId(match.id)),
					", ",
				)}.`,
				parameter: "source",
			})
		}
		return source
	})

type Row = typeof SourceConfigRow.Type

const toRow = (source: Source): Row => ({
	id: publicSourceId(source.id),
	name: source.name,
	description: source.description,
	platform: source.platform,
	kind: source.kind,
	tokenStatus: source.status,
	pausedAt: source.pausedAt,
	pausedUntil: source.pausedUntil,
	allowedSignals: source.allowedSignals,
	rateLimitRps: source.rateLimitRps,
	health: source.health.status,
	lastDataAt: source.health.lastDataAt,
})

const pausedCell = (row: Row) =>
	row.pausedAt === null
		? "no"
		: row.pausedUntil === null
			? `since ${row.pausedAt}, until resumed`
			: `since ${row.pausedAt}, until ${row.pausedUntil}`

const renderSource = (title: string, row: Row) => ({
	title,
	notices:
		row.pausedAt === null
			? []
			: [
					`Paused: data from "${row.name}" is dropped at ingest and is not stored or billed. ${TOOL} action=resume lets it in again.`,
				],
	blocks: [
		doc.fields([
			["Name", row.name],
			["Id", row.id],
			["Platform", row.platform],
			["Description", row.description ?? undefined],
			["Paused", pausedCell(row)],
			["Signals", row.allowedSignals === null ? "all" : Arr.join(row.allowedSignals, ", ")],
			["Rate limit", row.rateLimitRps === null ? "none" : `${row.rateLimitRps} requests/s`],
			["Health", row.health],
			["Last data", row.lastDataAt ?? "never"],
		]),
	],
	next: [doc.next("list_ingest_sources", {}, "every source and whether its data is arriving")],
})

export function registerIngestSourceTools(server: McpToolRegistrar) {
	server
		.family({
			name: TOOL,
			title: "Manage Ingest Source",
			description:
				"Pause, resume, change or delete an ingest source: one sender of telemetry with its own token or integration (list_ingest_sources lists them). Org admins and engineers only. A new source and a rolled token are created in Sources, where the token is shown once.",
			phrases: ["Managing an ingest source"],
		})
		.action("pause", {
			description:
				"Stop accepting a source's data: while paused, what it sends is dropped at ingest and is neither stored nor billed. With `resume_at` the pause lifts on its own; without it the source stays paused until action=resume. The default source (the org's own ingest keys) cannot be paused.",
			parameters: Schema.Struct({
				source: P.text("The source's name or `src_…` id"),
				resume_at: P.optionalTimestamp(
					"When the pause ends on its own (default: paused until resumed)",
				),
			}),
			hints: { readOnly: false, destructive: false, idempotent: true },
			permission: "sources:manage",
			handler: Effect.fn("McpTool.pauseIngestSource")(function* (params) {
				const tenant = yield* CurrentMcpTenant
				const service = yield* SourcesService
				const source = yield* resolveSource(tenant.orgId, params.source)
				const untilMs =
					params.resume_at === undefined ? null : parseWarehouseDateTime(params.resume_at)
				const paused = yield* service.pause(tenant.orgId, tenant.userId, source.id, untilMs).pipe(
					Effect.mapError((error) =>
						error._tag === "@maple/http/errors/SourceValidationError"
							? new McpInvalidInputError({
									message: error.message,
									parameter: untilMs === null ? "source" : "resume_at",
								})
							: toMcpSourceError(error),
					),
				)
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.source.id": paused.id })
				const audit = yield* toolAudit
				yield* audit.record({
					...audit.who,
					action: "source.paused",
					resourceId: paused.id,
					metadata: { name: paused.name, until: paused.pausedUntil, ...audit.origin },
				})
				return { action: "paused" as const, source: toRow(paused) }
			}),
			render: (output) => renderSource("Ingest source paused", output.source),
		})
		.action("resume", {
			description:
				"Accept a paused source's data again, from now on. What it sent while paused is gone.",
			parameters: Schema.Struct({
				source: P.text("The source's name or `src_…` id"),
			}),
			hints: { readOnly: false, destructive: false, idempotent: true },
			permission: "sources:manage",
			handler: Effect.fn("McpTool.resumeIngestSource")(function* (params) {
				const tenant = yield* CurrentMcpTenant
				const service = yield* SourcesService
				const source = yield* resolveSource(tenant.orgId, params.source)
				const resumed = yield* service
					.resume(tenant.orgId, tenant.userId, source.id)
					.pipe(Effect.mapError(toMcpSourceError))
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.source.id": resumed.id })
				const audit = yield* toolAudit
				yield* audit.record({
					...audit.who,
					action: "source.resumed",
					resourceId: resumed.id,
					metadata: { name: resumed.name, ...audit.origin },
				})
				return { action: "resumed" as const, source: toRow(resumed) }
			}),
			render: (output) => renderSource("Ingest source resumed", output.source),
		})
		.action("update", {
			description:
				"Change a source: its name or description, which signals its token may send (allowed_signals), or its rate limit. Fields left out keep their value. Signals and rate limits apply to sources with their own token, not to the default source or an integration's.",
			parameters: Schema.Struct({
				source: P.text("The source's name or `src_…` id"),
				name: P.optionalText("A new name"),
				description: P.optionalText("A new description"),
				clear_description: P.optionalFlag("Remove the description"),
				allowed_signals: P.optionalOneOfList(
					SourceSignal.literals,
					"The only signals its token may send; the rest are refused at ingest",
				),
				allow_all_signals: P.optionalFlag("Lift the signal restriction"),
				rate_limit_rps: P.optionalNumber("Requests per second its token may send"),
				clear_rate_limit: P.optionalFlag("Remove the rate limit"),
			}),
			hints: { readOnly: false, destructive: false, idempotent: true },
			permission: "sources:manage",
			handler: Effect.fn("McpTool.updateIngestSource")(function* (params) {
				const tenant = yield* CurrentMcpTenant
				const service = yield* SourcesService
				const source = yield* resolveSource(tenant.orgId, params.source)
				const request = yield* decodeUpdate({
					...(params.name === undefined ? undefined : { name: params.name }),
					...(params.clear_description === true
						? { description: null }
						: params.description === undefined
							? undefined
							: { description: params.description }),
					...(params.allow_all_signals === true
						? { allowedSignals: null }
						: params.allowed_signals === undefined
							? undefined
							: { allowedSignals: params.allowed_signals }),
					...(params.clear_rate_limit === true
						? { rateLimitRps: null }
						: params.rate_limit_rps === undefined
							? undefined
							: { rateLimitRps: params.rate_limit_rps }),
				}).pipe(
					Effect.mapError(
						() =>
							new McpInvalidInputError({
								message: "rate_limit_rps must be a whole number of requests per second.",
								parameter: "rate_limit_rps",
							}),
					),
				)
				if (Object.keys(request).length === 0) {
					return yield* new McpInvalidInputError({
						message: `Nothing to change: pass name, description, allowed_signals or rate_limit_rps. To pause "${source.name}" use ${TOOL} action=pause.`,
						parameter: "name",
					})
				}
				const updated = yield* service
					.update(tenant.orgId, tenant.userId, source.id, request)
					.pipe(Effect.mapError(toMcpSourceError))
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.source.id": updated.id })
				const audit = yield* toolAudit
				yield* audit.record({
					...audit.who,
					action: "source.updated",
					resourceId: updated.id,
					metadata: { name: updated.name, ...audit.origin },
				})
				return { action: "updated" as const, source: toRow(updated) }
			}),
			render: (output) => renderSource("Ingest source updated", output.source),
		})
		.action("delete", {
			description:
				"Delete a source that has its own token: the token stops working at once and whatever still sends with it is refused. Data already stored stays. Irreversible; requires confirm=true, and only for a source the user named: when they did not say which, list them and ask. To stop it for a while use action=pause. A source an integration collects is removed by disconnecting that integration in Sources.",
			parameters: Schema.Struct({
				source: P.text("The source's name or `src_…` id"),
				confirm: P.flag("Must be true. There is no undo."),
			}),
			hints: { readOnly: false, destructive: true, idempotent: false },
			permission: "sources:manage",
			handler: Effect.fn("McpTool.deleteIngestSource")(function* (params) {
				const tenant = yield* CurrentMcpTenant
				if (params.confirm !== true) {
					return yield* new McpInvalidInputError({
						message: `Deletion not confirmed. Re-call ${TOOL} action=delete with confirm=true to delete "${params.source}", or stop it for a while with ${TOOL} action=pause.`,
						parameter: "confirm",
					})
				}
				const service = yield* SourcesService
				const source = yield* resolveSource(tenant.orgId, params.source)
				const deleted = yield* service
					.delete(tenant.orgId, source.id)
					.pipe(Effect.mapError(toMcpSourceError))
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.source.id": deleted.id })
				const audit = yield* toolAudit
				yield* audit.record({
					...audit.who,
					action: "source.deleted",
					resourceId: deleted.id,
					metadata: { name: deleted.name, platform: deleted.platform, ...audit.origin },
				})
				return { deleted: true, id: publicSourceId(deleted.id), name: deleted.name }
			}),
			render: (output) => ({
				title: "Ingest source deleted",
				blocks: [
					doc.text(
						`Deleted "${output.name}" (${output.id}). Its token no longer works; the data it already sent stays.`,
					),
				],
				next: [doc.next("list_ingest_sources", {}, "the sources that remain")],
			}),
		})
}
