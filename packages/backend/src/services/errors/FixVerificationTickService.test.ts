import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, verificationVerdictAutoCloses, WarehouseQueryError } from "@maple/domain/http"
import { ErrorIssueId } from "@maple/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ErrorIssuePullRequests, ErrorIssues, ErrorIssueVerifications } from "@maple/db/tables"
import { Array as Arr, ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceApi,
} from "@maple/backend/services/warehouse/WarehouseQueryService"
import { ErrorActorsService } from "./ErrorActorsService"
import { ErrorIssueWorkflowService } from "./ErrorIssueWorkflowService"
import {
	FixVerificationTickService,
	splitVersionRows,
	verdictFromInvestigationStatus,
} from "./FixVerificationTickService"
import { InvestigationStarter } from "./InvestigationStarter"
import { IssueFixVerificationService } from "./IssueFixVerificationService"
import { PullRequestLookup } from "./PullRequestLookup"

/**
 * The verdict mapping is deliberately inverted relative to an incident
 * investigation, and that inversion is the whole reason these tests exist: a
 * reader who has not held the question the run was asked will see
 * `inconclusive -> verified` as a bug and "fix" it, and the fix silently
 * auto-closes every issue whose fix did NOT hold. Asserted literally, not
 * derived from the implementation.
 */
describe("verdictFromInvestigationStatus", () => {
	it("reads an established cause as the fix NOT holding", () => {
		const { verdict } = verdictFromInvestigationStatus("diagnosed")
		assert.strictEqual(verdict, "not_fixed")
	})

	it("reads finding nothing as the fix holding", () => {
		// The agent was asked to contradict a clean occurrence count. Failing to
		// do so corroborates it — the opposite of what `inconclusive` means for an
		// incident.
		const { verdict } = verdictFromInvestigationStatus("inconclusive")
		assert.strictEqual(verdict, "verified")
	})

	it("does not turn a run that never finished into a verdict either way", () => {
		for (const status of ["failed", "investigating", "cancelled"]) {
			const { verdict } = verdictFromInvestigationStatus(status)
			assert.strictEqual(verdict, "inconclusive", status)
		}
	})

	it("names the status it could not interpret, rather than guessing", () => {
		// A renamed or newly added investigation status falls here. It must stay
		// inconclusive (which earns a retry) and say so, never silently read as
		// `verified` — that path closes the issue.
		const { verdict, reason } = verdictFromInvestigationStatus("brand_new_status")
		assert.strictEqual(verdict, "inconclusive")
		assert.include(reason, "brand_new_status")
	})

	it("reaches the issue-closing verdict from exactly one status", () => {
		// `verified` is the only verdict that closes an issue (for a severity that
		// auto-closes at all), so the set of statuses producing it is the blast
		// radius of this mapping. Pinned as a set: widening it is how a failed fix
		// gets closed automatically.
		const verifying = Arr.filter(
			["diagnosed", "inconclusive", "failed", "investigating", "cancelled"],
			(status) => verdictFromInvestigationStatus(status).verdict === "verified",
		)
		assert.deepStrictEqual(verifying, ["inconclusive"])
		assert.strictEqual(verificationVerdictAutoCloses("low"), true)
		assert.strictEqual(verificationVerdictAutoCloses("critical"), false)
	})
})

describe("splitVersionRows", () => {
	it("splits attributable occurrences against the merge-time baseline", () => {
		const split = splitVersionRows(
			[
				{ serviceVersion: "v1", count: 40 },
				{ serviceVersion: "v3", count: 2 },
			],
			["v1", "v2"],
			1000,
		)
		assert.deepStrictEqual(split, { postMerge: 2, staleClients: 40, unattributed: 0 })
	})

	it("keeps a count of occurrences that report no build", () => {
		// The old code discarded these rows entirely, so a service that never
		// reports `service.version` looked identical to one that went silent — and
		// with a usable pre-merge rate the no-agent fallback then wrote `verified`
		// and auto-closed the issue while the error was still firing.
		const split = splitVersionRows([{ serviceVersion: "", count: 17 }], ["v1"], 1000)
		assert.strictEqual(split.unattributed, 17)
		assert.strictEqual(split.postMerge, 0)
	})

	it("treats a truncated version scan as incomplete evidence", () => {
		// Any single non-baseline build is decisive, so a scan that dropped rows
		// past its cap cannot claim the window was clean.
		const rows = Array.from({ length: 3 }, (_, index) => ({
			serviceVersion: `v${index}`,
			count: 1,
		}))
		const split = splitVersionRows(rows, ["v0", "v1", "v2"], 3)
		assert.isAbove(split.unattributed, 0)
	})
})

const ORG = Schema.decodeSync(OrgId)("org_verification_tick")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_verification_tick_other")
const DAY = 24 * 60 * 60_000
const NOW = 1_750_000_000_000
const PR_URL = "https://github.com/MapleTechLabs/maple/pull/612"

const createdDbs: TestDb[] = []
afterEach(async () => {
	await cleanupTestDbs(createdDbs)
})

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3478",
			MCP_PORT: "3479",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const unexpected = () => Effect.die(new Error("unexpected warehouse call"))

/** A warehouse whose every occurrence read fails, as a quarantined or broken org's does. */
const failingWarehouse: WarehouseQueryServiceApi = {
	query: unexpected,
	rawSqlQuery: unexpected,
	crossOrgQuery: unexpected,
	compiledQuery: () => Effect.fail(new WarehouseQueryError({ message: "warehouse unavailable" })),
	compiledQueryFirst: unexpected,
	ingest: () => Effect.void,
	asExecutor: () => {
		throw new Error("asExecutor is not supported by this test stub")
	},
}

const makeTickLayer = () => {
	const databaseLive = createTestDb(createdDbs).layer
	const actorsLive = ErrorActorsService.layer.pipe(Layer.provide(databaseLive))
	const workflowLive = Layer.effect(ErrorIssueWorkflowService, ErrorIssueWorkflowService.make).pipe(
		Layer.provide(AuditLogService.layerMemory),
		Layer.provide(databaseLive),
		Layer.provide(actorsLive),
	)
	const verificationLive = Layer.effect(IssueFixVerificationService, IssueFixVerificationService.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				databaseLive,
				Env.layer.pipe(Layer.provide(testConfig())),
				actorsLive,
				workflowLive,
				PullRequestLookup.none,
			),
		),
	)
	const tickLive = Layer.effect(FixVerificationTickService, FixVerificationTickService.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				databaseLive,
				verificationLive,
				Layer.succeed(WarehouseQueryService, failingWarehouse),
				// No row here reaches an investigation; without `ChatSessions` a start would record `no_binding`.
				InvestigationStarter.layer.pipe(Layer.provide(databaseLive)),
			),
		),
	)
	return Layer.mergeAll(tickLive, verificationLive, databaseLive)
}

/** An issue in review whose linked PR merged 30 days ago, so its window has long closed. */
const seedOverdueVerificationIn = Effect.fnUntraced(function* (org: OrgId) {
	const database = yield* Database
	const verification = yield* IssueFixVerificationService
	const issueId = Schema.decodeSync(ErrorIssueId)(randomUUID())
	yield* database.execute((db) =>
		db.run(
			PG.insertInto(ErrorIssues).values({
				id: issueId,
				orgId: org,
				kind: "error",
				fingerprintHash: `fp-${issueId}`,
				serviceName: "checkout",
				exceptionType: "TypeError",
				exceptionMessage: "undefined is not a function",
				errorLabel: "",
				topFrame: "src/checkout.ts:42",
				workflowState: "in_review",
				severity: "low",
				firstSeenAt: NOW - 40 * DAY,
				lastSeenAt: NOW - 31 * DAY,
				occurrenceCount: 200,
				seenVersionsJson: ["v1"],
				createdAt: NOW - 40 * DAY,
				updatedAt: NOW - 31 * DAY,
			}),
		),
	)
	yield* verification.linkPullRequest(org, null, issueId, PR_URL, "agent")
	yield* verification.onPullRequestEvent({
		orgId: org,
		provider: "github",
		externalRepoId: "999",
		repoFullName: "MapleTechLabs/maple",
		number: 612,
		action: "closed",
		url: PR_URL,
		title: "Fix the checkout crash",
		body: null,
		authorLogin: "octocat",
		merged: true,
		mergeCommitSha: "abc123",
		mergedAtMs: NOW - 30 * DAY,
	})
	return issueId
})
const seedOverdueVerification = seedOverdueVerificationIn(ORG)

const verificationOf = (issueId: ErrorIssueId) =>
	Effect.gen(function* () {
		const database = yield* Database
		const rows = yield* database.execute((db) =>
			db.run(
				PG.from(ErrorIssueVerifications)
					.select("status", "verifyAfter", "updatedAt")
					.where(($) => [$.issueId.eq(issueId)]),
			),
		)
		return rows[0]
	})

describe("FixVerificationTickService.runTick", () => {
	// Twenty rows like this used to fill every tick's page and block every other org.
	it.effect("settles a due row whose issue is gone, and does not examine it again", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const tick = yield* FixVerificationTickService
			const database = yield* Database
			const issueId = yield* seedOverdueVerification
			yield* database.execute((db) =>
				db.run(PG.deleteFrom(ErrorIssues).where(($) => [$.id.eq(issueId)])),
			)

			const first = yield* tick.runTick
			assert.strictEqual(first.examined, 1)
			assert.strictEqual(first.abandoned, 1)
			assert.strictEqual((yield* verificationOf(issueId))?.status, "abandoned")

			assert.strictEqual((yield* tick.runTick).examined, 0)
		}).pipe(Effect.provide(makeTickLayer())),
	)

	it.effect("sends a row whose occurrences cannot be read to the back, with its window intact", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const tick = yield* FixVerificationTickService
			const issueId = yield* seedOverdueVerification
			const before = yield* verificationOf(issueId)

			yield* TestClock.setTime(NOW + 60_000)
			const first = yield* tick.runTick
			assert.strictEqual(first.skipped, 1)
			// Not a verdict: still waiting, and the window an inconclusive verdict measures from is unchanged.
			const row = yield* verificationOf(issueId)
			assert.strictEqual(row?.status, "waiting")
			assert.strictEqual(row?.verifyAfter, before?.verifyAfter)
			// Touched, which is what puts it behind rows the tick has not reached yet.
			assert.strictEqual(row?.updatedAt, NOW + 60_000)

			assert.strictEqual((yield* tick.runTick).examined, 1)
		}).pipe(Effect.provide(makeTickLayer())),
	)

	// The link's URL goes into the verification agent's prompt, so it must be this org's link.
	it.effect("treats a row pointing at another org's pull request link as having none", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const tick = yield* FixVerificationTickService
			const database = yield* Database
			const issueId = yield* seedOverdueVerification
			const otherIssueId = yield* seedOverdueVerificationIn(OTHER_ORG)
			const otherLinks = yield* database.execute((db) =>
				db.run(
					PG.from(ErrorIssuePullRequests)
						.select("id")
						.where(($) => [$.orgId.eq(OTHER_ORG), $.issueId.eq(otherIssueId)]),
				),
			)
			const otherLink = otherLinks[0]
			assert.isDefined(otherLink)
			yield* database.execute((db) =>
				db.run(
					PG.update(ErrorIssueVerifications)
						.set({ pullRequestId: otherLink.id })
						.where(($) => [$.orgId.eq(ORG), $.issueId.eq(issueId)]),
				),
			)

			yield* tick.runTick
			assert.strictEqual((yield* verificationOf(issueId))?.status, "abandoned")
			// The other org's own row is untouched by it: its occurrences could not be read, so it waits.
			assert.strictEqual((yield* verificationOf(otherIssueId))?.status, "waiting")
		}).pipe(Effect.provide(makeTickLayer())),
	)
})
