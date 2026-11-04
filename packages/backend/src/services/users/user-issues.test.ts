import { afterEach, assert, describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Exit, Layer, Option, Schema } from "effect"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ErrorIssueFingerprints, ErrorIssues } from "@maple/db/tables"
import { ErrorIssueId, OrgId, UserDetailRequest, UserId, WarehouseSchemaDriftError } from "@maple/domain/http"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { affectedUsersResponse } from "@maple/backend/services/errors/ErrorIssueReadModelsService"
import { readUserActivity, readUserIssues } from "./users-reads"

// One user's issues: fingerprints resolved to the issue the errors tick lands them on, and a
// cluster whose `error_events` predates `UserId` (migration 0057) answering unattributed.

const ORG = Schema.decodeSync(OrgId)("org_user_issues")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_user_issues_other")
const asIssueId = Schema.decodeSync(ErrorIssueId)
const tenant: TenantContext = {
	orgId: ORG,
	userId: Schema.decodeSync(UserId)("user_member"),
	roles: ["org:admin"],
	authMode: "self_hosted",
}
const KEPT = asIssueId("00000000-0000-4000-8000-000000000001")
const MERGED = asIssueId("00000000-0000-4000-8000-000000000002")
const FOREIGN = asIssueId("00000000-0000-4000-8000-000000000003")

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const request = new UserDetailRequest({
	startTime: "2026-11-05 00:00:00",
	endTime: "2026-11-06 00:00:00",
	userId: "user_42",
})

const row = (fingerprintHash: string, hits: number, lastSeen: string, type = "TypeError") => ({
	fingerprintHash,
	serviceName: "checkout",
	exceptionType: type,
	exceptionMessage: `${type} in checkout`,
	errorLabel: "",
	hits: String(hits),
	firstSeen: "2026-11-05 08:00:00",
	lastSeen,
})

const missingUserId = new WarehouseSchemaDriftError({
	message: "Code: 47. Unknown expression identifier `UserId` in scope SELECT ...",
	pipeName: "userIssues",
	clickhouseType: "UNKNOWN_IDENTIFIER",
})

type Ran = Array<string>

/** Answers by query context; `failWith` fails every query naming `error_events`, like an old cluster. */
const warehouse = (rows: ReadonlyArray<unknown>, ran: Ran, failWith?: WarehouseSchemaDriftError) =>
	Layer.succeed(
		WarehouseQueryService,
		makeWarehouseServiceStub({
			compiledQuery: (_tenant, input, options) => {
				const compiled = compiledQueryOf(input)
				const context = options?.context ?? ""
				ran.push(context)
				if (failWith !== undefined && compiled.sql.includes("error_events"))
					return Effect.fail(failWith)
				return compiled.decodeRows(context === "userIssues" ? rows : []).pipe(Effect.orDie)
			},
		}),
	)

const seed = Effect.gen(function* () {
	const database = yield* Database
	const issue = (id: ErrorIssueId, orgId: OrgId, hash: string, state: "triage" | "in_progress") => ({
		id,
		orgId,
		fingerprintHash: hash,
		serviceName: "checkout",
		exceptionType: "CheckoutError",
		exceptionMessage: `issue ${hash}`,
		topFrame: "handler.ts:1",
		workflowState: state,
		firstSeenAt: 0,
		lastSeenAt: 0,
		createdAt: 0,
		updatedAt: 0,
	})
	yield* database.execute((db) =>
		db.run(
			PG.insertInto(ErrorIssues).values(
				issue(KEPT, ORG, "111", "in_progress"),
				issue(MERGED, ORG, "222", "triage"),
				issue(FOREIGN, OTHER_ORG, "333", "triage"),
			),
		),
	)
	// `222` was merged into the kept issue: its next occurrences land there.
	yield* database.execute((db) =>
		db.run(
			PG.insertInto(ErrorIssueFingerprints).values({
				orgId: ORG,
				fingerprintHash: "222",
				issueId: KEPT,
				source: "merge",
				originIssueId: MERGED,
				createdAt: 0,
			}),
		),
	)
})

describe("readUserIssues", () => {
	it.effect("folds a merged fingerprint onto the issue it lands on and links it", () => {
		const ran: Ran = []
		return Effect.gen(function* () {
			yield* seed
			const response = yield* readUserIssues(tenant, request)
			assert.isTrue(response.attributed)
			const [kept, unowned, ...rest] = response.issues
			assert.deepStrictEqual(rest, [])
			expect(kept).toMatchObject({
				issueId: KEPT,
				fingerprintHash: "111",
				type: "CheckoutError",
				message: "issue 111",
				hits: 7,
				status: "in_progress",
				lastSeenMs: Date.UTC(2026, 10, 5, 12),
			})
			// Another org's issue never owns this org's hash: it stays an unpromoted fingerprint.
			expect(unowned).toMatchObject({ issueId: null, fingerprintHash: "333", hits: 2, status: null })
		}).pipe(
			Effect.provide([
				warehouse(
					[
						row("111", 4, "2026-11-05 10:00:00"),
						row("333", 2, "2026-11-05 11:00:00"),
						row("222", 3, "2026-11-05 12:00:00"),
					],
					ran,
				),
				createTestDb(createdDbs).layer,
			]),
		)
	})

	it.effect("answers unattributed when error_events predates UserId, and the timeline still loads", () => {
		const ran: Ran = []
		return Effect.gen(function* () {
			const response = yield* readUserIssues(tenant, request)
			assert.isFalse(response.attributed)
			assert.deepStrictEqual(response.issues, [])
			const activity = yield* readUserActivity(tenant, request)
			assert.isFalse(activity.activity.some((item) => item.kind === "error"))
		}).pipe(Effect.provide([warehouse([], ran, missingUserId), createTestDb(createdDbs).layer]))
	})

	it.effect("surfaces any other schema drift", () => {
		const ran: Ran = []
		const drift = new WarehouseSchemaDriftError({
			message: "Unknown expression identifier `ErrorLabel`",
			pipeName: "userIssues",
			clickhouseType: "UNKNOWN_IDENTIFIER",
		})
		return Effect.gen(function* () {
			const exit = yield* Effect.exit(readUserIssues(tenant, request))
			assert.isTrue(Exit.isFailure(exit))
		}).pipe(Effect.provide([warehouse([], ran, drift), createTestDb(createdDbs).layer]))
	})

	it.effect("puts each issue on the timeline at its latest hit, linked to the issue", () => {
		const ran: Ran = []
		return Effect.gen(function* () {
			yield* seed
			const activity = yield* readUserActivity(tenant, request)
			const errors = activity.activity.filter((item) => item.kind === "error")
			expect(errors).toMatchObject([
				{ issueId: null, title: "TypeError", tone: "crit" },
				{ issueId: KEPT, title: "CheckoutError", detail: "4 hits · checkout · issue 111" },
			])
		}).pipe(
			Effect.provide([
				warehouse([row("111", 4, "2026-11-05 10:00:00"), row("444", 1, "2026-11-05 11:00:00")], ran),
				createTestDb(createdDbs).layer,
			]),
		)
	})
})

describe("affectedUsersResponse", () => {
	const count = { affectedUsers: 3, hitsWithUser: 6, hits: 8 }
	const lastSeen = DateTime.makeUnsafe(Date.UTC(2026, 10, 5, 9))

	it("keeps the totals coverage is computed from and each user's latest hit", () => {
		const response = affectedUsersResponse(
			Option.some(count),
			Option.some([{ userId: "u_1", hits: 4, lastSeen }]),
		)
		expect(response).toMatchObject({
			affectedUsers: 3,
			hitsWithUser: 6,
			hits: 8,
			attributed: true,
			users: [{ userId: "u_1", hits: 4, lastSeenMs: Date.UTC(2026, 10, 5, 9) }],
		})
	})

	it("reads zero over an empty window, still attributed", () => {
		const response = affectedUsersResponse(Option.some(undefined), Option.some([]))
		expect(response).toMatchObject({ affectedUsers: 0, hitsWithUser: 0, hits: 0, attributed: true })
	})

	it("is unattributed when either read found no UserId", () => {
		assert.isFalse(affectedUsersResponse(Option.none(), Option.some([])).attributed)
		assert.isFalse(affectedUsersResponse(Option.some(count), Option.none()).attributed)
	})
})
