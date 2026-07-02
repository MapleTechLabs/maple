import { BillingCustomer, type BillingUpstreamError } from "@maple/domain/http"
import { orgBillingSuspensions } from "@maple/db"
import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Redacted } from "effect"
import { decodeUpstream, ensureOk, makeCallAutumn } from "../lib/AutumnClient"
import { Database, type DatabaseError, type DatabaseShape, toDatabaseError } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { isPastDue, shouldSuspend } from "./BillingSuspensionPolicy"

const SUSPENSION_REASON = "unpaid_overdue"

export interface ReconcileResult {
	readonly scanned: number
	readonly suspended: number
	readonly cleared: number
}

// Resolves an org's Autumn customer (optionally with invoices expanded). The
// real implementation calls Autumn; tests inject a fake.
export type FetchCustomer = (
	orgId: string,
	expandInvoices: boolean,
) => Effect.Effect<BillingCustomer, BillingUpstreamError>

// --- DB primitives (Database-shape in, no Env/Autumn) -----------------------

const upsertOverdue = (database: DatabaseShape, orgId: string, nowMs: number) =>
	database
		.execute((db) =>
			db
				.insert(orgBillingSuspensions)
				.values({
					orgId,
					overdueSince: new Date(nowMs),
					suspendedAt: null,
					overdueInvoiceId: null,
					reason: SUSPENSION_REASON,
					createdAt: new Date(nowMs),
					updatedAt: new Date(nowMs),
				})
				// Idempotent: an existing row keeps its original overdueSince so the
				// 3-day clock isn't reset by repeated past_due webhooks.
				.onConflictDoNothing(),
		)
		.pipe(Effect.mapError(toDatabaseError))

const markSuspended = (
	database: DatabaseShape,
	orgId: string,
	nowMs: number,
	overdueInvoiceId: string | null,
) =>
	database
		.execute((db) =>
			db
				.update(orgBillingSuspensions)
				.set({ suspendedAt: new Date(nowMs), overdueInvoiceId, updatedAt: new Date(nowMs) })
				.where(eq(orgBillingSuspensions.orgId, orgId)),
		)
		.pipe(Effect.mapError(toDatabaseError))

const clearOrg = (database: DatabaseShape, orgId: string) =>
	database
		.execute((db) =>
			db.delete(orgBillingSuspensions).where(eq(orgBillingSuspensions.orgId, orgId)),
		)
		.pipe(Effect.mapError(toDatabaseError))

// --- Core logic (exported for tests) ----------------------------------------

// Webhook core: reconcile one org's overdue row from its (already-fetched)
// Autumn customer. past_due → ensure an overdue row; otherwise clear it.
export const applyOverdueState = (
	database: DatabaseShape,
	orgId: string,
	customer: BillingCustomer,
	nowMs: number,
): Effect.Effect<void, DatabaseError> =>
	isPastDue(customer)
		? upsertOverdue(database, orgId, nowMs).pipe(Effect.asVoid)
		: clearOrg(database, orgId).pipe(Effect.asVoid)

// Cron core: scope is the overdue set only (rows already present), never a
// full-org scan. Promotes pending rows past the grace window and clears settled
// ones. Per-org failures are logged and skipped so one bad org can't abort the sweep.
export const reconcileSuspensions = (
	database: DatabaseShape,
	fetchCustomer: FetchCustomer,
	nowMs: number,
): Effect.Effect<ReconcileResult, DatabaseError> =>
	Effect.gen(function* () {
		const rows = yield* database
			.execute((db) => db.select().from(orgBillingSuspensions))
			.pipe(Effect.mapError(toDatabaseError))

		let suspended = 0
		let cleared = 0

		yield* Effect.forEach(
			rows,
			(row) =>
				Effect.gen(function* () {
					const alreadySuspended = row.suspendedAt !== null
					// Invoices are only needed to evaluate a pending promotion.
					const customer = yield* fetchCustomer(row.orgId, !alreadySuspended)

					// Paid / reactivated → no longer past_due → clear (ingestion resumes).
					if (!isPastDue(customer)) {
						yield* clearOrg(database, row.orgId)
						cleared += 1
						return
					}
					// Already suspended and still past_due → stay suspended.
					if (alreadySuspended) return

					const decision = shouldSuspend({
						customer,
						overdueSince: row.overdueSince.getTime(),
						now: nowMs,
					})
					if (decision.suspend) {
						yield* markSuspended(database, row.orgId, nowMs, decision.overdueInvoiceId)
						suspended += 1
					}
				}).pipe(
					Effect.catch((error) =>
						Effect.logError("[billing] reconcile failed for org").pipe(
							Effect.annotateLogs({
								orgId: row.orgId,
								error: error instanceof Error ? error.message : String(error),
							}),
						),
					),
				),
			{ discard: true },
		)

		yield* Effect.annotateCurrentSpan({
			"billing.reconcile.scanned": rows.length,
			"billing.reconcile.suspended": suspended,
			"billing.reconcile.cleared": cleared,
		})
		return { scanned: rows.length, suspended, cleared } satisfies ReconcileResult
	})

// Owns the `org_billing_suspensions` table. The Autumn webhook drives
// `refreshOverdueState` (maintains the overdue clock authoritatively per org);
// the daily cron drives `runReconcile` (promotes overdue ≥3d + never-paid to
// suspended, and clears rows whose org has paid). The ingest gateway reads the
// resulting `suspended_at` flag directly from Postgres — never from this service.
export class BillingSuspensionService extends Context.Service<BillingSuspensionService>()(
	"@maple/api/services/BillingSuspensionService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const secretKey = Option.match(env.AUTUMN_SECRET_KEY, {
				onNone: () => undefined,
				onSome: (value) => Redacted.value(value),
			})
			const callAutumn = makeCallAutumn(secretKey)

			const fetchCustomer: FetchCustomer = (orgId, expandInvoices) =>
				callAutumn(
					"getOrCreateCustomer",
					expandInvoices ? { expand: ["invoices"] } : {},
					orgId,
				).pipe(
					Effect.flatMap(ensureOk),
					Effect.flatMap((response) => decodeUpstream(BillingCustomer, response)),
				)

			// Webhook entry point: re-derive an org's overdue state from Autumn (the
			// authoritative source) and reconcile its row. No-op when billing is
			// unconfigured so the webhook still 200s.
			const refreshOverdueState = Effect.fn("BillingSuspensionService.refreshOverdueState")(
				function* (orgId: string) {
					if (secretKey === undefined) return
					const now = yield* Clock.currentTimeMillis
					const customer = yield* fetchCustomer(orgId, false)
					yield* applyOverdueState(database, orgId, customer, now)
				},
			)

			// Cron entry point.
			const runReconcile = Effect.fn("BillingSuspensionService.runReconcile")(function* () {
				if (secretKey === undefined) {
					yield* Effect.logWarning(
						"[billing] reconcile skipped: AUTUMN_SECRET_KEY not configured",
					)
					return { scanned: 0, suspended: 0, cleared: 0 } satisfies ReconcileResult
				}
				const now = yield* Clock.currentTimeMillis
				return yield* reconcileSuspensions(database, fetchCustomer, now)
			})

			return { refreshOverdueState, runReconcile }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)

	static readonly refreshOverdueState = (orgId: string) =>
		this.use((service) => service.refreshOverdueState(orgId))

	static readonly runReconcile = () => this.use((service) => service.runReconcile())
}
