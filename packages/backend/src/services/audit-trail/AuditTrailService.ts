import type { AuditDetectionFilters, AuditTrailEvent } from "@maple/domain/audit-trail"
import { AuditTrailPersistenceError } from "@maple/domain/http"
import type { AuditTrailEntry } from "@maple/domain/http"
import type { OrgId } from "@maple/primitives"
import * as CH from "@maple/query-engine/ch"
import { Clock, Context, DateTime, Effect, Layer, Option, Array as Arr } from "effect"
import { ALERTING_SYSTEM_USER_ID, systemTenant } from "@maple/backend/services/auth/system-tenant"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { auditTrailEventToRow, storedRowToEntry } from "./audit-trail-row"

const AUDIT_TRAIL_DATASOURCE = "audit_trail_events"

export interface AuditTrailListFilters {
	readonly provider?: string
	readonly account?: string
	readonly category?: string
	readonly outcome?: string
	readonly action?: string
	/** An actor's provider id or email. */
	readonly actor?: string
	/** With `actor`: a second id the same person acts under. */
	readonly actorAlias?: string
	readonly sinceMs?: number
	readonly untilMs?: number
	/** Only events that sort after this one, newest first. */
	readonly before?: { readonly occurredAtMs: number; readonly id: string }
	readonly limit: number
}

/** One page, and where the next one starts; `next` is null on the last page. */
export interface AuditTrailPage {
	readonly events: ReadonlyArray<AuditTrailEntry>
	readonly next: { readonly occurredAtMs: number; readonly id: string } | null
}

export interface AuditTrailServiceApi {
	/**
	 * Store one org's events. Safe to repeat: the same event writes the same row. `bestEffort`
	 * is for a caller that drops the events on failure: the failed insert is a Warn, not an Error span.
	 */
	readonly write: (
		orgId: OrgId,
		events: ReadonlyArray<AuditTrailEvent>,
		options?: { readonly bestEffort?: boolean },
	) => Effect.Effect<void, AuditTrailPersistenceError>
	/** One org's audit events, newest first, `filters.limit` to a page. */
	readonly list: (
		orgId: OrgId,
		filters: AuditTrailListFilters,
	) => Effect.Effect<AuditTrailPage, AuditTrailPersistenceError>
	/** How many matching events arrived in `(startMs, endMs]`; a redelivered event counts once. */
	readonly count: (
		orgId: OrgId,
		filters: AuditDetectionFilters,
		window: { readonly startMs: number; readonly endMs: number },
	) => Effect.Effect<number, AuditTrailPersistenceError>
}

const persistenceError = (message: string) => (error: { readonly _tag: string }) =>
	new AuditTrailPersistenceError({ message, cause: error._tag })

/** Which optional filters bind, and the parameter values behind them. */
const listQueryInputs = (orgId: OrgId, filters: AuditTrailListFilters) => {
	const opts: CH.AuditTrailEventsOpts = {
		provider: filters.provider !== undefined,
		account: filters.account !== undefined,
		category: filters.category !== undefined,
		outcome: filters.outcome !== undefined,
		action: filters.action !== undefined,
		actor: filters.actor !== undefined,
		actorAlias: filters.actorAlias !== undefined,
		since: filters.sinceMs !== undefined,
		until: filters.untilMs !== undefined,
		before: filters.before !== undefined,
		// One row past the page says whether another page exists.
		limit: filters.limit + 1,
	}
	const values = {
		orgId,
		...(filters.provider !== undefined ? { provider: filters.provider } : undefined),
		...(filters.account !== undefined ? { account: filters.account } : undefined),
		...(filters.category !== undefined ? { category: filters.category } : undefined),
		...(filters.outcome !== undefined ? { outcome: filters.outcome } : undefined),
		...(filters.action !== undefined ? { action: filters.action } : undefined),
		...(filters.actor !== undefined ? { actor: filters.actor } : undefined),
		...(filters.actorAlias !== undefined ? { actorAlias: filters.actorAlias } : undefined),
		...(filters.sinceMs !== undefined ? { since: DateTime.makeUnsafe(filters.sinceMs) } : undefined),
		...(filters.untilMs !== undefined ? { until: DateTime.makeUnsafe(filters.untilMs) } : undefined),
		...(filters.before !== undefined
			? {
					beforeOccurredAt: DateTime.makeUnsafe(filters.before.occurredAtMs),
					beforeId: filters.before.id,
				}
			: undefined),
	}
	return { opts, values }
}

/** The unified audit trail: provider adapters write their events here and the Security hub lists them. */
export class AuditTrailService extends Context.Service<AuditTrailService, AuditTrailServiceApi>()(
	"@maple/backend/services/AuditTrailService",
	{
		make: Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService

			// A transient 5xx is retried: a duplicate row collapses on the event's key.
			const writeRows = Effect.fn("AuditTrailService.write")(function* (
				orgId: OrgId,
				events: ReadonlyArray<AuditTrailEvent>,
				bestEffort: boolean,
			) {
				const now = yield* Clock.currentTimeMillis
				yield* warehouse
					.ingest(
						systemTenant(orgId, ALERTING_SYSTEM_USER_ID),
						AUDIT_TRAIL_DATASOURCE,
						Arr.map(events, (event) => auditTrailEventToRow(orgId, event, now)),
						{ bestEffort, retryTransient: true },
					)
					.pipe(Effect.mapError(persistenceError("The audit trail could not be written")))
			})

			const write: AuditTrailServiceApi["write"] = (orgId, events, options) =>
				events.length === 0 ? Effect.void : writeRows(orgId, events, options?.bestEffort === true)

			const list: AuditTrailServiceApi["list"] = Effect.fn("AuditTrailService.list")(
				function* (orgId, filters) {
					const { opts, values } = listQueryInputs(orgId, filters)
					const rows = yield* warehouse
						.compiledQuery(
							systemTenant(orgId, ALERTING_SYSTEM_USER_ID),
							CH.compile(CH.auditTrailEventsQuery(opts), values),
							{ profile: "list", context: "auditTrailEvents" },
						)
						.pipe(Effect.mapError(persistenceError("The audit trail could not be read")))
					const entries = Arr.map(Arr.take(rows, filters.limit), storedRowToEntry)
					const last = Arr.last(entries)
					// A redelivered event the table has not merged yet is the same entry twice. When
					// the copy lands in the lookahead slot the next page can come back empty, which
					// is cheaper than ending the list early.
					const seen = new Set<string>()
					return {
						events: Arr.filter(
							entries,
							(entry) => !seen.has(entry.id) && seen.add(entry.id) !== undefined,
						),
						next:
							rows.length > filters.limit && Option.isSome(last)
								? { occurredAtMs: last.value.occurredAt, id: last.value.id }
								: null,
					}
				},
			)

			const count: AuditTrailServiceApi["count"] = Effect.fn("AuditTrailService.count")(
				function* (orgId, filters, window) {
					const rows = yield* warehouse
						.compiledQuery(
							systemTenant(orgId, ALERTING_SYSTEM_USER_ID),
							CH.compile(
								CH.auditTrailCountQuery({
									provider: filters.provider !== undefined,
									category: filters.category !== undefined,
									outcome: filters.outcome !== undefined,
									action: filters.action !== undefined,
								}),
								{
									orgId,
									...filters,
									start: DateTime.makeUnsafe(window.startMs),
									end: DateTime.makeUnsafe(window.endMs),
								},
								{ rowSchema: CH.auditTrailCountRowSchema },
							),
							{ profile: "aggregation", context: "auditTrailCount" },
						)
						.pipe(Effect.mapError(persistenceError("The audit trail could not be counted")))
					return rows[0]?.events ?? 0
				},
			)

			return { write, list, count }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
