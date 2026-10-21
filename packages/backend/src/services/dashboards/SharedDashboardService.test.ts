/**
 * Two branches of `SharedDashboardService` that the HTTP suite cannot reach.
 *
 * `dashboards.http.test.ts` covers the service well by proxy — mint-once,
 * mode-change-keeps-the-link, rotate atomicity, idempotent revoke, cascade
 * delete, cross-org isolation — so this file deliberately does not repeat any
 * of that. What it adds is the two paths no request can drive:
 *
 *   1. The lost-race branch, where two concurrent creates both read "not
 *      shared" and the partial unique index fails the loser. It exists so a
 *      double-click yields the winner's share instead of a 503, and it is
 *      exactly the code a later "simplify this to onConflictDoNothing" would
 *      quietly break.
 *   2. The missing-HMAC-key branch, where sharing is not configured on the
 *      deployment. Every HTTP harness supplies the key, so the failure that
 *      exists to stop the service hashing under a fallback — and minting links
 *      that stop resolving the moment the real key lands — is otherwise never
 *      executed.
 *
 * It also holds the service-level isolation cases: the HTTP layer checks the
 * dashboard belongs to the caller first, which hides a share query that forgot
 * its own `org_id`, `mode` or `revoked_at` predicate.
 */
import type { PGlite } from "@electric-sql/pglite"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { DashboardId, OrgId, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { ORG_A, ORG_B, USER_A, USER_B } from "@maple/backend/platform/test-two-orgs"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "./SharedDashboardService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_share_service")
const USER = Schema.decodeUnknownSync(UserId)("user_share_service")

const baseConfig = {
	PORT: "3482",
	MCP_PORT: "3483",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: ORG,
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	INTERNAL_SERVICE_TOKEN: "test-internal-token",
}

/**
 * `shareTokenHmacKey: null` omits the key entirely, which is the not-configured case.
 * `beforeQuery` runs ahead of every service statement, so a test can land a concurrent
 * write at an exact point inside one service call instead of hoping the scheduler does.
 */
const makeRuntime = (
	shareTokenHmacKey: string | null,
	beforeQuery?: (sql: string, run: (sql: string) => Promise<void>) => Promise<void>,
) => {
	const testDb = createTestDb(createdDbs)
	if (beforeQuery !== undefined) {
		// The layer reads `query` off the instance per call, so shadowing it here is enough.
		const pglite = testDb.pglite
		const query = pglite.query.bind(pglite)
		pglite.query = async (...args: Parameters<PGlite["query"]>) => {
			await beforeQuery(args[0], async (sql) => {
				await query(sql)
			})
			return query(...args)
		}
	}
	const envLive = Env.layer.pipe(
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					...baseConfig,
					...(shareTokenHmacKey === null
						? undefined
						: { MAPLE_SHARE_TOKEN_HMAC_KEY: shareTokenHmacKey }),
				}),
			),
		),
	)
	const services = Layer.mergeAll(SharedDashboardService.layer, DashboardPersistenceService.layer).pipe(
		Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)),
	)

	return { runtime: ManagedRuntime.make(services), testDb }
}

const createDashboard = (
	runtime: ManagedRuntime.ManagedRuntime<never, never>,
	orgId: OrgId = ORG,
	userId: UserId = USER,
) =>
	runtime.runPromise(
		Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const dashboard = yield* persistence.create(orgId, userId, {
				name: "Ops",
				timeRange: { type: "relative", value: "12h" },
				widgets: [],
				variables: [],
			})
			return dashboard.id
		}) as Effect.Effect<DashboardId, never, never>,
	)

describe("SharedDashboardService", () => {
	it("never leaves two live links behind when creates run concurrently", async () => {
		const { runtime, testDb } = makeRuntime("maple-test-share-secret")
		try {
			const dashboardId = await createDashboard(runtime)
			const scope = { dashboardId, widgetId: null }

			// Genuinely concurrent, rather than a forced interleaving. The read and
			// the insert inside `upsert` are not one transaction and deliberately so
			// — two creates that both read "not shared" are meant to collide on
			// `dashboard_shares_live_unq` and have the loser re-read the winner.
			//
			// Whether this run actually hits that branch depends on scheduling, so
			// the assertions below are the ones that must hold EITHER WAY. A test
			// that only passed when the race triggered would be flaky; this one
			// exercises the branch when it can and pins the invariant when it
			// cannot.
			const [first, second] = await runtime.runPromise(
				Effect.all(
					[
						SharedDashboardService.use((shares) => shares.upsert(ORG, USER, scope, "public")),
						SharedDashboardService.use((shares) => shares.upsert(ORG, USER, scope, "public")),
					],
					{ concurrency: 2 },
				),
			)

			// One share, whoever won — never two links for one scope.
			expect(second.id).toBe(first.id)

			// And one link: the loser takes the update-in-place branch and reads the
			// winner's token back out of storage, so both callers are handed the same
			// URL rather than one of them holding a link that never resolved.
			expect(second.token).toBe(first.token)

			// The invariant the partial unique index exists to hold, checked in the
			// table rather than through the service that just wrote it.
			const live = await queryFirstRow<{ n: number }>(
				testDb,
				"SELECT count(*)::int AS n FROM dashboard_shares WHERE revoked_at IS NULL",
			)
			expect(live?.n).toBe(1)
		} finally {
			await runtime.dispose()
		}
	})

	it("hands the same token back on a later read, and binds it to its own row", async () => {
		const { runtime, testDb } = makeRuntime("maple-test-share-secret")
		try {
			const dashboardId = await createDashboard(runtime)
			const scope = { dashboardId, widgetId: null }

			const created = await runtime.runPromise(
				SharedDashboardService.use((shares) => shares.upsert(ORG, USER, scope, "public")),
			)

			// The point of storing an encrypted copy: a read that never saw the mint
			// response still produces the link, so nobody has to rotate — and break
			// every URL already pasted somewhere — merely to see their own.
			const read = await runtime.runPromise(
				SharedDashboardService.use((shares) => shares.get(ORG, scope)),
			)
			expect(read._tag).toBe("Some")
			if (read._tag === "Some") expect(read.value.token).toBe(created.token)

			// Ciphertext, not the token in disguise: what is on disk must not be the
			// value, or the encryption is decorative.
			const stored = await queryFirstRow<{ ciphertext: string; hash: string }>(
				testDb,
				"SELECT token_ciphertext AS ciphertext, token_hash AS hash FROM dashboard_shares WHERE revoked_at IS NULL",
			)
			expect(stored?.ciphertext).not.toContain(created.token)
			expect(stored?.hash).not.toContain(created.token)

			// The AAD binds the ciphertext to its row: copying one share's
			// (ciphertext, iv, tag) onto another share must not decrypt. Without it,
			// database write access alone would let an attacker graft a working link
			// onto a dashboard they are allowed to read.
			const other = await createDashboard(runtime)
			const otherScope = { dashboardId: other, widgetId: null }
			await runtime.runPromise(
				SharedDashboardService.use((shares) => shares.upsert(ORG, USER, otherScope, "public")),
			)
			await executeSql(
				testDb,
				`UPDATE dashboard_shares AS target
				 SET token_ciphertext = source.token_ciphertext,
				     token_iv = source.token_iv,
				     token_tag = source.token_tag
				 FROM dashboard_shares AS source
				 WHERE target.dashboard_id = $1 AND source.dashboard_id = $2
				   AND target.revoked_at IS NULL AND source.revoked_at IS NULL`,
				[other, dashboardId],
			)

			const relocated = await runtime.runPromise(
				Effect.result(SharedDashboardService.use((shares) => shares.get(ORG, otherScope))),
			)
			expect(relocated._tag).toBe("Failure")
		} finally {
			await runtime.dispose()
		}
	})

	it("refuses every operation when no HMAC key is configured", async () => {
		const { runtime } = makeRuntime(null)
		try {
			const dashboardId = await createDashboard(runtime)
			const scope = { dashboardId, widgetId: null }

			const created = await runtime.runPromise(
				Effect.result(
					SharedDashboardService.use((shares) => shares.upsert(ORG, USER, scope, "public")),
				),
			)
			const resolved = await runtime.runPromise(
				Effect.result(
					SharedDashboardService.use((shares) => shares.resolveByToken("mshare_anything")),
				),
			)

			// Failing is the point: hashing under a fallback key would mint links
			// that silently stop resolving the moment the real key is deployed.
			expect(created._tag).toBe("Failure")
			expect(resolved._tag).toBe("Failure")
			if (created._tag === "Failure") {
				expect(created.failure._tag).toBe("@maple/http/errors/ShareNotConfiguredError")
			}
		} finally {
			await runtime.dispose()
		}
	})

	it("keeps revoke idempotent, and does not resurrect a revoked link", async () => {
		const { runtime } = makeRuntime("maple-test-share-secret")
		try {
			const dashboardId = await createDashboard(runtime)
			const scope = { dashboardId, widgetId: null }

			const created = await runtime.runPromise(
				SharedDashboardService.use((shares) => shares.upsert(ORG, USER, scope, "public")),
			)
			const token = created.token

			const first = await runtime.runPromise(
				SharedDashboardService.use((shares) => shares.revoke(ORG, USER, scope)),
			)
			const second = await runtime.runPromise(
				SharedDashboardService.use((shares) => shares.revoke(ORG, USER, scope)),
			)

			// The first revoke did something; the second is a no-op rather than a
			// 404, so the dialog can call it without checking first.
			expect(first.revoked).toBe(true)
			expect(second.revoked).toBe(false)

			const afterRevoke = await runtime.runPromise(
				Effect.result(SharedDashboardService.use((shares) => shares.resolveByToken(token))),
			)
			expect(afterRevoke._tag).toBe("Failure")

			// A fresh share mints a NEW token; the revoked one stays dead. Sharing
			// again must not resurrect a link someone was told had been killed.
			const reshared = await runtime.runPromise(
				SharedDashboardService.use((shares) => shares.upsert(ORG, USER, scope, "public")),
			)
			expect(reshared.token).toBeDefined()
			expect(reshared.token).not.toBe(token)

			const stillDead = await runtime.runPromise(
				Effect.result(SharedDashboardService.use((shares) => shares.resolveByToken(token))),
			)
			expect(stillDead._tag).toBe("Failure")
		} finally {
			await runtime.dispose()
		}
	})
})

describe("SharedDashboardService isolation", () => {
	const shares = <A, E>(f: (service: typeof SharedDashboardService.Service) => Effect.Effect<A, E>) =>
		SharedDashboardService.use(f)

	it("never lets another org read, change, rotate or revoke a share", async () => {
		const { runtime, testDb } = makeRuntime("maple-test-share-secret")
		try {
			const dashboardA = await createDashboard(runtime, ORG_A, USER_A)
			await createDashboard(runtime, ORG_B, USER_B)
			const scopeA = { dashboardId: dashboardA, widgetId: null }
			const shareA = await runtime.runPromise(shares((s) => s.upsert(ORG_A, USER_A, scopeA, "public")))

			const seenByB = await runtime.runPromise(shares((s) => s.get(ORG_B, scopeA)))
			expect(seenByB._tag).toBe("None")
			const listedByB = await runtime.runPromise(shares((s) => s.listForDashboard(ORG_B, dashboardA)))
			expect(listedByB).toEqual([])

			// B can neither mint a share on A's board (the composite FK refuses it) nor rotate A's.
			const upsertedByB = await runtime.runPromise(
				Effect.exit(shares((s) => s.upsert(ORG_B, USER_B, scopeA, "org"))),
			)
			expect(Exit.isFailure(upsertedByB)).toBe(true)
			const rotatedByB = await runtime.runPromise(
				Effect.exit(shares((s) => s.rotate(ORG_B, USER_B, scopeA))),
			)
			expect(Exit.isFailure(rotatedByB)).toBe(true)
			const revokedByB = await runtime.runPromise(shares((s) => s.revoke(ORG_B, USER_B, scopeA)))
			expect(revokedByB.revoked).toBe(false)
			expect(await runtime.runPromise(shares((s) => s.listForDashboard(ORG_B, dashboardA)))).toEqual([])
			const rows = await queryFirstRow<{ total: number; outsideA: number }>(
				testDb,
				'SELECT count(*)::int AS total, (count(*) FILTER (WHERE org_id <> $2))::int AS "outsideA" FROM dashboard_shares WHERE dashboard_id = $1',
				[dashboardA, ORG_A],
			)
			expect(rows).toEqual({ total: 1, outsideA: 0 })

			const after = await runtime.runPromise(shares((s) => s.get(ORG_A, scopeA)))
			expect(
				after._tag === "Some" ? [after.value.id, after.value.mode, after.value.token] : [],
			).toEqual([shareA.id, "public", shareA.token])
			const resolved = await runtime.runPromise(shares((s) => s.resolveByToken(shareA.token)))
			expect(resolved.orgId).toBe(ORG_A)
		} finally {
			await runtime.dispose()
		}
	})

	it("serves a share by id publicly only while its mode is public", async () => {
		const { runtime } = makeRuntime("maple-test-share-secret")
		try {
			const dashboardId = await createDashboard(runtime, ORG_A, USER_A)
			const scope = { dashboardId, widgetId: null }
			const orgOnly = await runtime.runPromise(shares((s) => s.upsert(ORG_A, USER_A, scope, "org")))

			const hidden = await runtime.runPromise(
				Effect.result(shares((s) => s.resolvePublicById(orgOnly.id))),
			)
			expect(hidden._tag).toBe("Failure")

			await runtime.runPromise(shares((s) => s.upsert(ORG_A, USER_A, scope, "public")))
			const shown = await runtime.runPromise(shares((s) => s.resolvePublicById(orgOnly.id)))
			expect([shown.id, shown.orgId]).toEqual([orgOnly.id, ORG_A])
		} finally {
			await runtime.dispose()
		}
	})

	it("does not change the mode of a link revoked between the read and the write", async () => {
		// Lands a revoke right before upsert's mode UPDATE, after its live-share read.
		const { runtime, testDb } = makeRuntime("maple-test-share-secret", async (sql, run) => {
			if (/^update "dashboard_shares" set "mode"/i.test(sql.trimStart())) {
				await run("UPDATE dashboard_shares SET revoked_at = now() WHERE revoked_at IS NULL")
			}
		})
		try {
			const dashboardId = await createDashboard(runtime, ORG_A, USER_A)
			const scope = { dashboardId, widgetId: null }
			const created = await runtime.runPromise(shares((s) => s.upsert(ORG_A, USER_A, scope, "public")))

			const flipped = await runtime.runPromise(
				Effect.result(shares((s) => s.upsert(ORG_A, USER_A, scope, "org"))),
			)
			expect(flipped._tag).toBe("Failure")

			const stored = await queryFirstRow<{ mode: string; revoked: boolean }>(
				testDb,
				"SELECT mode, revoked_at IS NOT NULL AS revoked FROM dashboard_shares WHERE id = $1",
				[created.id],
			)
			expect(stored).toEqual({ mode: "public", revoked: true })
		} finally {
			await runtime.dispose()
		}
	})
})
