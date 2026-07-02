import { afterEach, describe, expect, it } from "@effect/vitest"
import { BillingCustomer, BillingInvoice, BillingSubscription } from "@maple/domain/http"
import { Effect } from "effect"
import { Database } from "../lib/DatabaseLive"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "../lib/test-pglite"
import { OVERDUE_GRACE_MS } from "./BillingSuspensionPolicy"
import {
	applyOverdueState,
	type FetchCustomer,
	reconcileSuspensions,
} from "./BillingSuspensionService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const NOW = 1_700_000_000_000

const subscription = (pastDue: boolean) =>
	new BillingSubscription({ planId: "startup", status: "active", pastDue })

const customer = (opts: { pastDue: boolean; paid?: boolean }) =>
	new BillingCustomer({
		id: "org_x",
		subscriptions: [subscription(opts.pastDue)],
		invoices: opts.paid
			? [new BillingInvoice({ stripeId: "in_paid", status: "paid" })]
			: [new BillingInvoice({ stripeId: "in_open", status: "open" })],
	})

const fakeFetch =
	(byOrg: Record<string, BillingCustomer>): FetchCustomer =>
	(orgId) =>
		Effect.succeed(byOrg[orgId] ?? customer({ pastDue: false }))

const seedOverdue = (db: TestDb, orgId: string, overdueSinceMs: number, suspendedAtMs?: number) =>
	executeSql(
		db,
		`INSERT INTO org_billing_suspensions
			(org_id, overdue_since, suspended_at, overdue_invoice_id, reason, created_at, updated_at)
		 VALUES ($1, $2, $3, NULL, 'unpaid_overdue', $4, $4)`,
		[
			orgId,
			new Date(overdueSinceMs).toISOString(),
			suspendedAtMs === undefined ? null : new Date(suspendedAtMs).toISOString(),
			new Date(NOW).toISOString(),
		],
	)

const readRow = (db: TestDb, orgId: string) =>
	queryFirstRow<{ org_id: string; suspended_at: string | null; overdue_invoice_id: string | null }>(
		db,
		"SELECT org_id, suspended_at, overdue_invoice_id FROM org_billing_suspensions WHERE org_id = $1",
		[orgId],
	)

const run = (db: TestDb, program: Effect.Effect<unknown, unknown, Database>) =>
	Effect.runPromise(program.pipe(Effect.provide(db.layer)) as Effect.Effect<unknown>)

// Migrations apply lazily when the Database layer is first built. Force that
// before any raw-SQL seeding so the table exists.
const ensureMigrated = (db: TestDb) => run(db, Effect.void)

describe("applyOverdueState", () => {
	it("inserts an overdue row when the customer is past_due", async () => {
		const db = createTestDb(trackedDbs)
		await run(
			db,
			Effect.gen(function* () {
				const database = yield* Database
				yield* applyOverdueState(database, "org_a", customer({ pastDue: true }), NOW)
			}),
		)
		const row = await readRow(db, "org_a")
		expect(row?.org_id).toBe("org_a")
		expect(row?.suspended_at).toBeNull()
	})

	it("clears the row when the customer is no longer past_due", async () => {
		const db = createTestDb(trackedDbs)
		await ensureMigrated(db)
		await seedOverdue(db, "org_a", NOW - OVERDUE_GRACE_MS - 1)
		await run(
			db,
			Effect.gen(function* () {
				const database = yield* Database
				yield* applyOverdueState(database, "org_a", customer({ pastDue: false }), NOW)
			}),
		)
		expect(await readRow(db, "org_a")).toBeUndefined()
	})
})

describe("reconcileSuspensions", () => {
	it("suspends an overdue-≥3d, never-paid org", async () => {
		const db = createTestDb(trackedDbs)
		await ensureMigrated(db)
		await seedOverdue(db, "org_overdue", NOW - OVERDUE_GRACE_MS - 1)

		const result = (await run(
			db,
			Effect.gen(function* () {
				const database = yield* Database
				return yield* reconcileSuspensions(
					database,
					fakeFetch({ org_overdue: customer({ pastDue: true }) }),
					NOW,
				)
			}),
		)) as { scanned: number; suspended: number; cleared: number }

		expect(result).toEqual({ scanned: 1, suspended: 1, cleared: 0 })
		const row = await readRow(db, "org_overdue")
		expect(row?.suspended_at).not.toBeNull()
		expect(row?.overdue_invoice_id).toBe("in_open")
	})

	it("does not suspend before the grace window elapses", async () => {
		const db = createTestDb(trackedDbs)
		await ensureMigrated(db)
		await seedOverdue(db, "org_recent", NOW - 2 * 24 * 60 * 60 * 1000)

		await run(
			db,
			Effect.gen(function* () {
				const database = yield* Database
				return yield* reconcileSuspensions(
					database,
					fakeFetch({ org_recent: customer({ pastDue: true }) }),
					NOW,
				)
			}),
		)
		expect((await readRow(db, "org_recent"))?.suspended_at).toBeNull()
	})

	it("clears a suspended org once it has paid", async () => {
		const db = createTestDb(trackedDbs)
		await ensureMigrated(db)
		await seedOverdue(db, "org_paid", NOW - OVERDUE_GRACE_MS - 1, NOW - 1000)

		const result = (await run(
			db,
			Effect.gen(function* () {
				const database = yield* Database
				return yield* reconcileSuspensions(
					database,
					fakeFetch({ org_paid: customer({ pastDue: false, paid: true }) }),
					NOW,
				)
			}),
		)) as { scanned: number; suspended: number; cleared: number }

		expect(result.cleared).toBe(1)
		expect(await readRow(db, "org_paid")).toBeUndefined()
	})
})
