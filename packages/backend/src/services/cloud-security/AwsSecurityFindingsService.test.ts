import * as Retry from "@distilled.cloud/aws/Retry"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ENABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { AwsAccountId, type AwsModule, AwsRegion, OrgId, UserId } from "@maple/primitives"
import { Array as Arr, ConfigProvider, Effect, Layer, Schema, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { AwsConnectionService } from "../integrations/AwsConnectionService"
import { MAPLE_TEST_OIDC_KEY, makeFakeAws } from "../integrations/aws/fake-aws"
import { MAX_PAGES, WINDOW_PAGES } from "./aws-security-readers"
import {
	AwsSecurityFindingsService,
	NOT_ENABLED_RECHECK_MS,
	PUSHED_POLL_MS,
	RECONCILE_AFTER_MS,
} from "./AwsSecurityFindingsService"
import { CloudSecurityStore } from "./CloudSecurityStore"
import { AuditTrailService } from "../audit-trail/AuditTrailService"
import type { AuditTrailEvent } from "@maple/domain/audit-trail"
import { CLOUDTRAIL_LATE_MS, CLOUDTRAIL_OVERLAP_MS } from "./aws-security-readers"
import { type FakeGuardDutyFinding, type FakeRegion, makeFakeAwsSecurity } from "./fake-aws-security"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const config = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.test/",
	MAPLE_API_BASE_URL: "https://api.maple.test/",
	MAPLE_AWS_OIDC_SIGNING_KEY: MAPLE_TEST_OIDC_KEY.privateKey,
}

const orgId = Schema.decodeSync(OrgId)("org_sec")
const userId = Schema.decodeSync(UserId)("user_1")
const account = Schema.decodeSync(AwsAccountId)("111111111111")

const makeWorld = () => {
	const testDb = createTestDb(trackedDbs)
	const sts = makeFakeAws()
	const aws = makeFakeAwsSecurity(sts.client)
	const rolledOut = new Set<OrgId>([orgId])
	const audit: Array<{ readonly orgId: OrgId; readonly event: AuditTrailEvent }> = []
	const layer = Layer.mergeAll(
		Layer.effect(AwsSecurityFindingsService, AwsSecurityFindingsService.make),
		Layer.effect(AwsConnectionService, AwsConnectionService.make),
	).pipe(
		Layer.provideMerge(CloudSecurityStore.layer),
		Layer.provide(
			Layer.succeed(AuditTrailService, {
				write: (org, events) =>
					Effect.sync(() => {
						audit.push(...Arr.map(events, (event) => ({ orgId: org, event })))
					}),
				list: () => Effect.die("unused"),
				count: () => Effect.die("unused"),
				providerStats: () => Effect.die("unused"),
			}),
		),
		Layer.provide(
			Layer.succeed(OrganizationFeatureFlagsService, {
				flags: (org) =>
					Effect.sync(() => ({
						...ENABLED_ORGANIZATION_FEATURE_FLAGS,
						cloudSecurity: rolledOut.has(org),
					})),
			}),
		),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(Layer.succeed(HttpClient.HttpClient, aws.client)),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
	)
	return { testDb, sts, aws, rolledOut, audit, layer }
}

type World = ReturnType<typeof makeWorld>

/** The tests' "now": every fixture is dated before it. */
const NOW = Date.parse("2026-11-10T00:00:00Z")

const connect = (world: World, granted: ReadonlyArray<AwsModule> = ["security"]) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		const connections = yield* AwsConnectionService
		const created = yield* connections.create(orgId, userId, {
			accountId: account,
			modules: ["security"],
		})
		const setup = yield* connections.setup(orgId, created.id)
		world.sts.deploy(account, setup.cloudformationTemplate)
		yield* Effect.promise(() =>
			executeSql(world.testDb, "UPDATE aws_connections SET granted_modules = $2::jsonb WHERE id = $1", [
				created.id,
				JSON.stringify(granted),
			]),
		)
		return created
	})

/** One tick, without the SDK's backoff sleeps, which never end under the test clock. */
const poll = AwsSecurityFindingsService.use((service) => Retry.none(service.pollAll))

const findingRows = (world: World) =>
	Effect.promise(() =>
		world.testDb.pglite
			.query<{
				source: string
				region: string
				finding_id: string
				severity: string
				status: string
				resource_id: string
				occurrences: number
			}>(
				"SELECT source, region, finding_id, severity, status, resource_id, occurrences FROM cloud_security_findings ORDER BY source, finding_id",
			)
			.then((result) => result.rows),
	)

const sshBruteForce = (overrides: Partial<FakeGuardDutyFinding> = {}): FakeGuardDutyFinding => ({
	id: "gd-1",
	type: "UnauthorizedAccess:EC2/SSHBruteForce",
	title: "SSH brute force against i-0abc",
	severity: 8,
	updatedAtMs: Date.parse("2026-11-01T00:00:00Z"),
	count: 12,
	instanceId: "i-0abc",
	...overrides,
})

describe("AwsSecurityFindingsService", () => {
	it.effect("stores each service's findings per region and records where a service is off", () => {
		const world = makeWorld()
		world.aws.regions["us-east-1"] = {
			guardduty: [sshBruteForce()],
			inspector: [
				{
					arn: "arn:aws:inspector2:us-east-1:111111111111:finding/1",
					title: "CVE-2026-0001 - openssl",
					severity: "CRITICAL",
					status: "ACTIVE",
					updatedAtMs: Date.parse("2026-11-02T00:00:00Z"),
					cve: "CVE-2026-0001",
				},
			],
		}
		world.aws.regions["eu-west-1"] = {
			accessAnalyzer: [
				{
					id: "aa-1",
					findingType: "ExternalAccess",
					status: "ACTIVE",
					resource: "arn:aws:s3:::public-bucket",
					updatedAtMs: Date.parse("2026-11-03T00:00:00Z"),
				},
			],
		}
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			const summary = yield* poll
			assert.deepStrictEqual(summary, {
				connections: 1,
				failedConnections: 0,
				reads: 10,
				findings: 3,
				auditEvents: 0,
			})
			assert.deepStrictEqual(yield* findingRows(world), [
				{
					source: "access_analyzer",
					region: "eu-west-1",
					finding_id: "aa-1",
					severity: "high",
					status: "active",
					resource_id: "arn:aws:s3:::public-bucket",
					occurrences: 1,
				},
				{
					source: "guardduty",
					region: "us-east-1",
					finding_id: "gd-1",
					severity: "high",
					status: "active",
					resource_id: "i-0abc",
					occurrences: 12,
				},
				{
					source: "inspector",
					region: "us-east-1",
					finding_id: "arn:aws:inspector2:us-east-1:111111111111:finding/1",
					severity: "critical",
					status: "active",
					resource_id: "i-0inspected",
					occurrences: 1,
				},
			])
			const store = yield* CloudSecurityStore
			const states = yield* store.serviceStates(orgId, connection.id)
			const stateOf = (region: string, source: string) =>
				Arr.findFirst(states, (state) => state.region === region && state.source === source).pipe(
					(found) => (found._tag === "Some" ? found.value.state : "missing"),
				)
			assert.strictEqual(stateOf("us-east-1", "guardduty"), "enabled")
			assert.strictEqual(stateOf("us-east-1", "securityhub"), "not_enabled")
			assert.strictEqual(stateOf("eu-west-1", "guardduty"), "not_enabled")
			assert.strictEqual(stateOf("eu-west-1", "access_analyzer"), "enabled")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("reads only what changed since the cursor and keeps the latest version", () => {
		const world = makeWorld()
		const region = { guardduty: [sshBruteForce()] }
		world.aws.regions["us-east-1"] = region
		return Effect.gen(function* () {
			yield* connect(world)
			yield* poll
			region.guardduty = [
				sshBruteForce({ archived: true, count: 30, updatedAtMs: Date.parse("2026-11-05T00:00:00Z") }),
			]
			world.aws.requests.length = 0
			yield* poll
			const listed = Arr.filter(
				world.aws.requests,
				(request) => request.service === "guardduty" && Str.endsWith("/findings")(request.path),
			)
			assert.deepStrictEqual(
				Arr.map(listed, (request) => request.body["findingCriteria"]),
				[
					{
						criterion: {
							accountId: { equals: ["111111111111"] },
							updatedAt: { greaterThanOrEqual: Date.parse("2026-11-01T00:00:00Z") },
						},
					},
				],
			)
			const [row] = yield* findingRows(world)
			assert.strictEqual(row?.status, "archived")
			assert.strictEqual(row?.occurrences, 30)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("leaves out Security Hub's copies of the other services and closes passed controls", () => {
		const world = makeWorld()
		const at = Date.parse("2026-11-01T00:00:00Z")
		const region = {
			securityhub: [
				{
					id: "sh-control",
					productName: "Security Hub",
					generatorId: "S3.1",
					title: "S3 public access",
					label: "HIGH",
					updatedAtMs: at,
				},
				{
					id: "sh-passed",
					productName: "Security Hub",
					generatorId: "IAM.1",
					title: "Root MFA",
					label: "CRITICAL",
					updatedAtMs: at,
					compliance: "FAILED" as const,
				},
				{
					id: "sh-gd-copy",
					productName: "GuardDuty",
					generatorId: "gd",
					title: "Copy",
					label: "HIGH",
					updatedAtMs: at,
				},
			],
		}
		world.aws.regions["us-east-1"] = region
		return Effect.gen(function* () {
			yield* connect(world)
			yield* poll
			// Fixed: the control passes on its next check, which moves its update time.
			region.securityhub = Arr.map(region.securityhub, (finding) =>
				finding.id === "sh-passed"
					? { ...finding, compliance: "PASSED" as const, updatedAtMs: at + 60_000 }
					: finding,
			)
			yield* TestClock.adjust("5 minutes")
			yield* poll
			const rows = yield* findingRows(world)
			assert.deepStrictEqual(
				Arr.map(rows, (row) => [row.finding_id, row.status]),
				[
					["sh-control", "active"],
					["sh-passed", "resolved"],
				],
			)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("records a service the role may not read as denied and still reads the rest", () => {
		const world = makeWorld()
		world.aws.regions["us-east-1"] = { guardduty: [sshBruteForce()], securityhub: [] }
		world.aws.denied.add("securityhub")
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			yield* poll
			const store = yield* CloudSecurityStore
			const hub = Arr.findFirst(
				yield* store.serviceStates(orgId, connection.id),
				(state) => state.source === "securityhub",
			)
			assert.strictEqual(hub._tag === "Some" ? hub.value.state : "missing", "denied")
			assert.include(hub._tag === "Some" ? (hub.value.lastError ?? "") : "", "SecurityHub.DescribeHub")
			assert.strictEqual((yield* findingRows(world)).length, 1)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("asks a service that is off again only after an hour", () => {
		const world = makeWorld()
		world.aws.regions["us-east-1"] = { guardduty: [] }
		return Effect.gen(function* () {
			yield* connect(world)
			yield* TestClock.setTime(Date.parse("2026-11-10T00:00:00Z"))
			yield* poll
			const hubCalls = () =>
				Arr.filter(world.aws.requests, (request) => request.service === "securityhub").length
			assert.strictEqual(hubCalls(), 1)
			yield* TestClock.adjust("10 minutes")
			yield* poll
			assert.strictEqual(hubCalls(), 1)
			yield* TestClock.adjust(NOT_ENABLED_RECHECK_MS)
			yield* poll
			assert.strictEqual(hubCalls(), 2)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("reads a feed whose events arrive only every 30 minutes, and the others every tick", () => {
		const world = makeWorld()
		world.aws.regions["us-east-1"] = { guardduty: [sshBruteForce()], securityhub: [] }
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			const store = yield* CloudSecurityStore
			yield* TestClock.setTime(Date.parse("2026-11-10T00:00:00Z"))
			yield* poll
			const calls = (service: string) =>
				Arr.filter(world.aws.requests, (request) => request.service === service).length
			const [guardDuty, hub] = [calls("guardduty"), calls("securityhub")]
			yield* store.recordPush(
				{
					orgId,
					connectionId: connection.id,
					region: Schema.decodeSync(AwsRegion)("us-east-1"),
					source: "guardduty",
				},
				Date.parse("2026-11-10T00:01:00Z"),
			)
			yield* TestClock.adjust("10 minutes")
			yield* poll
			// GuardDuty's events carry its changes; Security Hub, with none, is read as before.
			assert.strictEqual(calls("guardduty"), guardDuty)
			assert.isAbove(calls("securityhub"), hub)
			yield* TestClock.adjust(PUSHED_POLL_MS)
			yield* poll
			assert.isAbove(calls("guardduty"), guardDuty)
			// A read that ended short (capped or failing) keeps going every tick, events or not.
			const usEast = Schema.decodeSync(AwsRegion)("us-east-1")
			yield* store.recordServiceState({
				orgId,
				connectionId: connection.id,
				region: usEast,
				source: "guardduty",
				state: "enabled",
				cursorAt: null,
				windowMs: null,
				lastError: "More findings changed than one poll reads; the next one continues.",
				checkedAt: Date.parse("2026-11-10T00:41:00Z"),
			})
			const afterCapped = calls("guardduty")
			yield* TestClock.adjust("10 minutes")
			yield* poll
			assert.isAbove(calls("guardduty"), afterCapped)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("continues a long first read from where the last page left off", () => {
		const world = makeWorld()
		const start = Date.parse("2026-11-01T00:00:00Z")
		const total = MAX_PAGES * 50 + 10
		world.aws.regions["us-east-1"] = {
			guardduty: Arr.makeBy(total, (index) =>
				sshBruteForce({ id: `gd-${index}`, updatedAtMs: start + index * 1000 }),
			),
		}
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			yield* poll
			assert.strictEqual((yield* findingRows(world)).length, MAX_PAGES * 50)
			const store = yield* CloudSecurityStore
			const [state] = Arr.filter(
				yield* store.serviceStates(orgId, connection.id),
				(row) => row.source === "guardduty",
			)
			assert.strictEqual(state?.cursorAt, start + (MAX_PAGES * 50 - 1) * 1000)
			assert.isNotNull(state?.lastError ?? null)
			yield* poll
			assert.strictEqual((yield* findingRows(world)).length, total)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("skips orgs outside the rollout and connections whose role does not grant security", () => {
		const world = makeWorld()
		world.aws.regions["us-east-1"] = { guardduty: [sshBruteForce()] }
		return Effect.gen(function* () {
			yield* connect(world, [])
			assert.deepStrictEqual(yield* poll, {
				connections: 0,
				failedConnections: 0,
				reads: 0,
				findings: 0,
				auditEvents: 0,
			})
			yield* Effect.promise(() =>
				executeSql(
					world.testDb,
					"UPDATE aws_connections SET granted_modules = '[\"security\"]'::jsonb",
				),
			)
			world.rolledOut.clear()
			assert.strictEqual((yield* poll).connections, 0)
			assert.deepStrictEqual(world.aws.requests, [])
		}).pipe(Effect.provide(world.layer))
	})
	it.effect("writes CloudTrail changes to the audit log and leaves out role-session plumbing", () => {
		const world = makeWorld()
		const at = Date.parse("2026-11-10T00:00:00Z")
		const record = (
			eventName: string,
			eventSource: string,
			identity: Record<string, unknown>,
			extra = {},
		) => ({
			eventSource,
			eventName,
			userIdentity: identity,
			sourceIPAddress: "203.0.113.7",
			userAgent: "aws-cli/2",
			...extra,
		})
		const alice = { type: "IAMUser", arn: "arn:aws:iam::111111111111:user/alice", userName: "alice" }
		world.aws.regions["us-east-1"] = {
			cloudtrail: [
				{
					eventId: "ct-key",
					eventTimeMs: at - 60_000,
					record: record("CreateAccessKey", "iam.amazonaws.com", alice, {
						errorCode: "AccessDenied",
						errorMessage: "not allowed",
					}),
				},
				{
					eventId: "ct-login",
					eventTimeMs: at - 30_000,
					record: record("ConsoleLogin", "signin.amazonaws.com", alice, {
						responseElements: { ConsoleLogin: "Success" },
					}),
				},
				{
					eventId: "ct-assume",
					eventTimeMs: at - 20_000,
					record: record("AssumeRole", "sts.amazonaws.com", {
						type: "AssumedRole",
						arn: "arn:aws:sts::1:assumed-role/app/x",
					}),
				},
				{
					eventId: "ct-aws",
					eventTimeMs: at - 10_000,
					record: record("PutBucketPolicy", "s3.amazonaws.com", {
						type: "AWSService",
						invokedBy: "s3.amazonaws.com",
					}),
				},
			],
		}
		return Effect.gen(function* () {
			yield* connect(world)
			// Events are read once they are older than the late margin.
			const firstPollAt = at + CLOUDTRAIL_LATE_MS + 60_000
			yield* TestClock.setTime(firstPollAt)
			const summary = yield* poll
			assert.strictEqual(summary.auditEvents, 2)
			assert.deepStrictEqual(
				Arr.map(world.audit, ({ orgId: org, event }) => [
					org,
					event.action,
					event.category,
					event.outcome,
					event.actor.name,
				]),
				[
					[orgId, "signin:ConsoleLogin", "authentication", "success", "alice"],
					[orgId, "iam:CreateAccessKey", "credential", "denied", "alice"],
				],
			)
			world.aws.requests.length = 0
			yield* TestClock.adjust("5 minutes")
			yield* poll
			const [lookup] = Arr.filter(world.aws.requests, (request) => request.service === "cloudtrail")
			// The next read starts a little before where the last one stopped.
			assert.strictEqual(
				lookup?.body["StartTime"],
				(firstPollAt - CLOUDTRAIL_LATE_MS - CLOUDTRAIL_OVERLAP_MS) / 1000,
			)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("catches up on more Inspector findings than one poll reads, one whole window at a time", () => {
		const world = makeWorld()
		// Past the 2,000 a single capped read used to stop at.
		const total = MAX_PAGES * 100 + 100
		world.aws.regions["us-east-1"] = {
			inspector: Arr.makeBy(total, (index) => ({
				arn: `arn:aws:inspector2:us-east-1:111111111111:finding/${index}`,
				title: `CVE ${index}`,
				severity: "HIGH",
				status: "ACTIVE" as const,
				updatedAtMs: NOW - 2 * 24 * 3600_000 + index * 60_000,
			})),
		}
		const inspectorPages = () =>
			Arr.filter(world.aws.requests, (request) => request.path === "/findings/list").length
		return Effect.gen(function* () {
			yield* connect(world)
			const polls = yield* Effect.forEach(Arr.range(1, 8), () =>
				Effect.gen(function* () {
					world.aws.requests.length = 0
					yield* poll
					yield* TestClock.adjust("5 minutes")
					return inspectorPages()
				}),
			)
			assert.isTrue(Arr.every(polls, (pages) => pages <= MAX_PAGES))
			assert.strictEqual((yield* findingRows(world)).length, total)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("resolves an Access Analyzer finding that is gone from a whole read", () => {
		const world = makeWorld()
		const finding = (id: string) => ({
			id,
			findingType: "ExternalAccess",
			status: "ACTIVE" as const,
			resource: `arn:aws:s3:::${id}`,
			updatedAtMs: NOW - 3600_000,
		})
		const region = {
			accessAnalyzer: [
				finding("aa-1"),
				finding("aa-2"),
				{ ...finding("aa-old"), status: "RESOLVED" as const },
			],
		}
		world.aws.regions["us-east-1"] = region
		return Effect.gen(function* () {
			yield* connect(world)
			yield* poll
			region.accessAnalyzer = [finding("aa-1")]
			yield* TestClock.adjust("5 minutes")
			yield* poll
			assert.deepStrictEqual(
				Arr.map(yield* findingRows(world), (row) => [row.finding_id, row.status]),
				[
					["aa-1", "active"],
					["aa-2", "resolved"],
				],
			)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("picks up a Security Hub status changed in the console, which leaves UpdatedAt alone", () => {
		const world = makeWorld()
		const control = {
			id: "sh-1",
			productName: "Security Hub",
			generatorId: "EC2.19",
			title: "Security group open to the world",
			label: "HIGH",
			updatedAtMs: NOW - 3600_000,
		}
		// A newer finding moves the cursor past the control, so only the reconcile can see it again.
		const newer = { ...control, id: "sh-2", generatorId: "S3.1", updatedAtMs: NOW - 60_000 }
		const region = { securityhub: [control, newer] }
		world.aws.regions["us-east-1"] = region
		return Effect.gen(function* () {
			yield* connect(world)
			yield* poll
			region.securityhub = [{ ...control, workflow: "SUPPRESSED" as const }, newer]
			yield* TestClock.adjust("10 minutes")
			yield* poll
			assert.strictEqual((yield* findingRows(world))[0]?.status, "active")
			yield* TestClock.adjust(RECONCILE_AFTER_MS)
			yield* poll
			assert.strictEqual((yield* findingRows(world))[0]?.status, "archived")
			// Reopened in the console, again without moving UpdatedAt.
			region.securityhub = [{ ...control, workflow: "NEW" as const }, newer]
			yield* TestClock.adjust(RECONCILE_AFTER_MS + 60_000)
			yield* poll
			assert.strictEqual((yield* findingRows(world))[0]?.status, "active")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("picks up a GuardDuty finding archived without a new update time", () => {
		const world = makeWorld()
		const old = sshBruteForce({ id: "gd-old", updatedAtMs: NOW - 3600_000 })
		const newer = sshBruteForce({ id: "gd-new", updatedAtMs: NOW - 60_000 })
		const region = { guardduty: [old, newer] }
		world.aws.regions["us-east-1"] = region
		return Effect.gen(function* () {
			yield* connect(world)
			yield* poll
			region.guardduty = [{ ...old, archived: true }, newer]
			yield* TestClock.adjust(RECONCILE_AFTER_MS + 60_000)
			yield* poll
			const rows = yield* findingRows(world)
			assert.deepStrictEqual(
				Arr.map(rows, (row) => [row.finding_id, row.status]),
				[
					["gd-new", "active"],
					["gd-old", "archived"],
				],
			)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("leaves out member accounts' and linked regions' findings an administrator lists", () => {
		const world = makeWorld()
		const base = {
			productName: "Security Hub",
			generatorId: "S3.1",
			title: "S3",
			label: "HIGH",
			updatedAtMs: NOW - 60_000,
		}
		world.aws.regions["us-east-1"] = {
			securityhub: [
				{ ...base, id: "own" },
				{ ...base, id: "member", accountId: "222222222222" },
				{ ...base, id: "linked", region: "eu-west-1" },
			],
			guardduty: [
				sshBruteForce({ id: "gd-own" }),
				sshBruteForce({ id: "gd-member", accountId: "222222222222" }),
			],
			inspector: [
				{
					arn: "insp-member",
					title: "CVE",
					severity: "HIGH",
					status: "ACTIVE" as const,
					updatedAtMs: NOW - 3600_000,
					accountId: "222222222222",
				},
			],
		}
		return Effect.gen(function* () {
			yield* connect(world)
			yield* poll
			assert.deepStrictEqual(
				Arr.map(yield* findingRows(world), (row) => row.finding_id),
				["gd-own", "own"],
			)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("catches up on a burst of CloudTrail writes and never reads the read-only ones", () => {
		const world = makeWorld()
		const burst = 1200
		const write = (index: number) => ({
			eventId: `ct-${index}`,
			eventTimeMs: NOW - 10 * 60_000 + index * 400,
			record: {
				eventSource: "ec2.amazonaws.com",
				eventName: "RunInstances",
				userIdentity: { type: "IAMUser", userName: "ci" },
			},
		})
		world.aws.regions["us-east-1"] = {
			cloudtrail: [
				...Arr.makeBy(burst, write),
				{
					...write(burst),
					eventId: "ct-read",
					readOnly: true,
					record: { ...write(burst).record, eventName: "DescribeInstances" },
				},
			],
		}
		return Effect.gen(function* () {
			yield* connect(world)
			yield* TestClock.adjust(CLOUDTRAIL_LATE_MS)
			yield* Effect.forEach(
				Arr.range(1, 8),
				() => Effect.andThen(poll, TestClock.adjust("5 minutes")),
				{
					discard: true,
				},
			)
			const ids = new Set(Arr.map(world.audit, ({ event }) => event.providerEventId))
			assert.strictEqual(ids.size, burst)
			assert.isFalse(ids.has("ct-read"))
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("asks a service the role may not read again only after an hour", () => {
		const world = makeWorld()
		world.aws.regions["us-east-1"] = { guardduty: [] }
		world.aws.denied.add("inspector2")
		const inspectorCalls = () =>
			Arr.filter(world.aws.requests, (request) => request.service === "inspector2").length
		return Effect.gen(function* () {
			yield* connect(world)
			yield* poll
			yield* TestClock.adjust("10 minutes")
			yield* poll
			assert.strictEqual(inspectorCalls(), 1)
			yield* TestClock.adjust(NOT_ENABLED_RECHECK_MS)
			yield* poll
			assert.strictEqual(inspectorCalls(), 2)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("writes each org's findings only under that org and its own account", () => {
		const world = makeWorld()
		const otherOrg = Schema.decodeSync(OrgId)("org_other")
		world.rolledOut.add(otherOrg)
		world.aws.regions["us-east-1"] = {
			guardduty: [
				sshBruteForce({ id: "gd-a" }),
				sshBruteForce({ id: "gd-b", accountId: "222222222222" }),
			],
		}
		return Effect.gen(function* () {
			yield* connect(world)
			const connections = yield* AwsConnectionService
			const other = yield* connections.create(otherOrg, userId, {
				accountId: Schema.decodeSync(AwsAccountId)("222222222222"),
				modules: ["security"],
			})
			const setup = yield* connections.setup(otherOrg, other.id)
			world.sts.deploy("222222222222", setup.cloudformationTemplate)
			yield* Effect.promise(() =>
				executeSql(
					world.testDb,
					"UPDATE aws_connections SET granted_modules = '[\"security\"]'::jsonb",
				),
			)
			yield* poll
			const rows = yield* Effect.promise(() =>
				world.testDb.pglite
					.query<{ org_id: string; account_id: string; finding_id: string }>(
						"SELECT org_id, account_id, finding_id FROM cloud_security_findings ORDER BY finding_id",
					)
					.then((result) => result.rows),
			)
			assert.deepStrictEqual(rows, [
				{ org_id: "org_sec", account_id: "111111111111", finding_id: "gd-a" },
				{ org_id: "org_other", account_id: "222222222222", finding_id: "gd-b" },
			])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("reads a second in which Inspector updated more findings than one window takes, whole", () => {
		const world = makeWorld()
		const massUpdate = NOW - 30 * 60_000
		const total = WINDOW_PAGES * 100 + 200
		world.aws.regions["us-east-1"] = {
			inspector: [
				...Arr.makeBy(total, (index) => ({
					arn: `arn:aws:inspector2:us-east-1:111111111111:finding/mass-${index}`,
					title: "CVE-2026-9999",
					severity: "CRITICAL",
					status: "ACTIVE" as const,
					updatedAtMs: massUpdate,
				})),
				{
					arn: "arn:aws:inspector2:us-east-1:111111111111:finding/later",
					title: "CVE-2026-0002",
					severity: "LOW",
					status: "ACTIVE" as const,
					updatedAtMs: NOW - 10 * 60_000,
				},
			],
		}
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			yield* Effect.forEach(
				Arr.range(1, 8),
				() => Effect.andThen(poll, TestClock.adjust("5 minutes")),
				{
					discard: true,
				},
			)
			const rows = yield* findingRows(world)
			// Fewer than a poll's pages: the second is read whole, not skipped.
			assert.strictEqual(rows.length, total + 1)
			assert.isTrue(Arr.some(rows, (row) => Str.endsWith("/later")(row.finding_id)))
			const store = yield* CloudSecurityStore
			const [state] = Arr.filter(
				yield* store.serviceStates(orgId, connection.id),
				(row) => row.source === "inspector",
			)
			assert.isAbove(state?.cursorAt ?? 0, massUpdate)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("moves past a dense burst of CloudTrail writes right at the cursor while behind", () => {
		const world = makeWorld()
		const lagged = NOW - 40 * 60_000
		const burst = 300
		world.aws.regions["us-east-1"] = {
			cloudtrail: Arr.makeBy(burst, (index) => ({
				eventId: `ct-${index}`,
				eventTimeMs: lagged + 1000 + index * 100,
				record: {
					eventSource: "ec2.amazonaws.com",
					eventName: "RunInstances",
					userIdentity: { type: "IAMUser", userName: "ci" },
				},
			})),
		}
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			// The region's cursor sits just before the burst, well behind the late margin.
			const store = yield* CloudSecurityStore
			yield* store.recordServiceState({
				orgId,
				connectionId: connection.id,
				region: Schema.decodeSync(AwsRegion)("us-east-1"),
				source: "cloudtrail",
				state: "enabled",
				cursorAt: lagged,
				windowMs: null,
				lastError: null,
				checkedAt: NOW - 60_000,
			})
			yield* Effect.forEach(
				Arr.range(1, 3),
				() => Effect.andThen(poll, TestClock.adjust("5 minutes")),
				{
					discard: true,
				},
			)
			assert.strictEqual(
				new Set(Arr.map(world.audit, ({ event }) => event.providerEventId)).size,
				burst,
			)
			const [state] = Arr.filter(
				yield* store.serviceStates(orgId, connection.id),
				(row) => row.source === "cloudtrail",
			)
			assert.isAbove(state?.cursorAt ?? 0, lagged + 1000 + burst * 100)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("resolves nothing while an analyzer is not active", () => {
		const world = makeWorld()
		const finding = {
			id: "aa-1",
			findingType: "ExternalAccess",
			status: "ACTIVE" as const,
			resource: "arn:aws:s3:::shared",
			updatedAtMs: NOW - 3600_000,
		}
		const region: FakeRegion = { accessAnalyzer: [finding] }
		world.aws.regions["us-east-1"] = region
		return Effect.gen(function* () {
			yield* connect(world)
			yield* poll
			// Recreated: the new analyzer is still creating and lists nothing yet.
			region.analyzerStatus = "CREATING"
			region.accessAnalyzer = []
			yield* TestClock.adjust("5 minutes")
			yield* poll
			assert.strictEqual((yield* findingRows(world))[0]?.status, "active")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("reads a burst just past the cursor whole, however busy the minutes behind it", () => {
		const world = makeWorld()
		const cursor = NOW - 40 * 60_000
		const write = (id: string, eventTimeMs: number) => ({
			eventId: id,
			eventTimeMs,
			record: {
				eventSource: "ec2.amazonaws.com",
				eventName: "RunInstances",
				userIdentity: { type: "IAMUser", userName: "ci" },
			},
		})
		world.aws.regions["us-east-1"] = {
			cloudtrail: [
				// Already read: the overlap behind the cursor finds them again.
				...Arr.makeBy(400, (index) => write(`before-${index}`, cursor - 120_000 + index * 100)),
				// 1,500 writes in the 5 s after the cursor: thirty pages.
				...Arr.makeBy(1500, (index) => write(`burst-${index}`, cursor + 1 + Math.floor(index * 3.3))),
			],
		}
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			const store = yield* CloudSecurityStore
			yield* store.recordServiceState({
				orgId,
				connectionId: connection.id,
				region: Schema.decodeSync(AwsRegion)("us-east-1"),
				source: "cloudtrail",
				state: "enabled",
				cursorAt: cursor,
				windowMs: 3132,
				lastError: null,
				checkedAt: NOW - 60_000,
			})
			yield* Effect.forEach(
				Arr.range(1, 4),
				() => Effect.andThen(poll, TestClock.adjust("5 minutes")),
				{
					discard: true,
				},
			)
			const burst = Arr.filter(world.audit, ({ event }) =>
				Str.startsWith("burst-")(event.providerEventId),
			)
			assert.strictEqual(new Set(Arr.map(burst, ({ event }) => event.providerEventId)).size, 1500)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("gives a dense second at the cursor every page of a poll, even with writes behind it", () => {
		const world = makeWorld()
		const cursor = NOW - 40 * 60_000
		const write = (id: string, eventTimeMs: number) => ({
			eventId: id,
			eventTimeMs,
			record: {
				eventSource: "ec2.amazonaws.com",
				eventName: "RunInstances",
				userIdentity: { type: "IAMUser", userName: "ci" },
			},
		})
		world.aws.regions["us-east-1"] = {
			cloudtrail: [
				// One write a second in the minutes behind the cursor.
				...Arr.makeBy(180, (index) => write(`behind-${index}`, cursor - 180_000 + index * 1000)),
				// 1,900 writes in one second just past it: 38 pages, under a poll's 40.
				...Arr.makeBy(1900, (index) => write(`dense-${index}`, cursor + 500)),
			],
		}
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			const store = yield* CloudSecurityStore
			yield* store.recordServiceState({
				orgId,
				connectionId: connection.id,
				region: Schema.decodeSync(AwsRegion)("us-east-1"),
				source: "cloudtrail",
				state: "enabled",
				cursorAt: cursor,
				windowMs: 60_000,
				lastError: null,
				checkedAt: NOW - 60_000,
			})
			yield* Effect.forEach(
				Arr.range(1, 5),
				() => Effect.andThen(poll, TestClock.adjust("5 minutes")),
				{
					discard: true,
				},
			)
			const dense = Arr.filter(world.audit, ({ event }) =>
				Str.startsWith("dense-")(event.providerEventId),
			)
			assert.strictEqual(new Set(Arr.map(dense, ({ event }) => event.providerEventId)).size, 1900)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("steps past an update time shared by more findings than a poll reads", () => {
		const world = makeWorld()
		const tie = NOW - 3600_000
		const region = {
			guardduty: Arr.makeBy(MAX_PAGES * 50 + 100, (index) =>
				sshBruteForce({ id: `gd-tie-${index}`, updatedAtMs: tie }),
			),
		}
		world.aws.regions["us-east-1"] = region
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			yield* poll
			yield* TestClock.adjust("5 minutes")
			yield* poll
			region.guardduty = [
				...region.guardduty,
				sshBruteForce({ id: "gd-after", updatedAtMs: tie + 60_000 }),
			]
			yield* TestClock.adjust("5 minutes")
			yield* poll
			const store = yield* CloudSecurityStore
			const [state] = Arr.filter(
				yield* store.serviceStates(orgId, connection.id),
				(row) => row.source === "guardduty",
			)
			assert.isAbove(state?.cursorAt ?? 0, tie)
			assert.isTrue(Arr.some(yield* findingRows(world), (row) => row.finding_id === "gd-after"))
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("brings back a Security Hub finding resolved and then reopened in the console", () => {
		const world = makeWorld()
		const control = {
			id: "sh-1",
			productName: "Security Hub",
			generatorId: "EC2.19",
			title: "Security group open to the world",
			label: "HIGH",
			updatedAtMs: NOW - 3600_000,
		}
		const newer = { ...control, id: "sh-2", generatorId: "S3.1", updatedAtMs: NOW - 60_000 }
		const region = { securityhub: [control, newer] }
		world.aws.regions["us-east-1"] = region
		return Effect.gen(function* () {
			yield* connect(world)
			yield* poll
			region.securityhub = [{ ...control, workflow: "RESOLVED" as const }, newer]
			yield* TestClock.adjust(RECONCILE_AFTER_MS + 60_000)
			yield* poll
			assert.strictEqual((yield* findingRows(world))[0]?.status, "resolved")
			region.securityhub = [{ ...control, workflow: "NEW" as const }, newer]
			yield* TestClock.adjust(RECONCILE_AFTER_MS + 60_000)
			yield* poll
			assert.strictEqual((yield* findingRows(world))[0]?.status, "active")
		}).pipe(Effect.provide(world.layer))
	})
})
