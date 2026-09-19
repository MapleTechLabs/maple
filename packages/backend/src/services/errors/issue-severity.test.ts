import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { AiTriageResult } from "@maple/domain/http"
import { ErrorIssueId, OrgId } from "@maple/domain/primitives"
import { actors, errorIssues, errorIssueEvents, issueEscalations } from "@maple/db"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	applyTriageSeverity,
	type ApplyTriageSeverityInput,
	escalationReasonFor,
	severityRank,
	TRIAGE_AGENT_NAME,
} from "./issue-severity"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const decodeTriageResult = Schema.decodeUnknownSync(AiTriageResult)

const ORG = asOrgId("org_severity_test")

/**
 * One seeded issue per test on a fresh embedded Postgres. The helpers close
 * over the same `Database`, so the severity write and the reads that check it
 * run against the same rows.
 */
const setup = Effect.gen(function* () {
	const database = yield* Database
	const issueId = asIssueId(randomUUID())
	const now = new Date()
	yield* database.execute((db) =>
		db.insert(errorIssues).values({
			id: issueId,
			orgId: ORG,
			fingerprintHash: "12345678901234567890",
			serviceName: "checkout-api",
			exceptionType: "TimeoutError",
			exceptionMessage: "upstream timed out",
			topFrame: "",
			firstSeenAt: now,
			lastSeenAt: now,
			createdAt: now,
			updatedAt: now,
		}),
	)

	const baseInput = (overrides: Partial<ApplyTriageSeverityInput> = {}): ApplyTriageSeverityInput => ({
		orgId: ORG,
		issueId,
		runId: "run-1",
		severity: "high",
		confidence: "medium",
		timestamp: Date.now(),
		...overrides,
	})

	const apply = (overrides: Partial<ApplyTriageSeverityInput> = {}) =>
		database.execute((db) => applyTriageSeverity(db, baseInput(overrides)))

	const setIssueSeverity = (
		severity: "critical" | "high" | "medium" | "low",
		severitySource: "manual" | "detector",
	) =>
		database.execute((db) =>
			db.update(errorIssues).set({ severity, severitySource }).where(eq(errorIssues.id, issueId)),
		)

	const loadIssue = Effect.map(
		database.execute((db) => db.select().from(errorIssues).where(eq(errorIssues.id, issueId))),
		(rows) => rows[0],
	)
	const loadEvents = database.execute((db) =>
		db.select().from(errorIssueEvents).where(eq(errorIssueEvents.issueId, issueId)),
	)
	const loadEscalations = database.execute((db) =>
		db.select().from(issueEscalations).where(eq(issueEscalations.issueId, issueId)),
	)
	const loadAgents = database.execute((db) => db.select().from(actors).where(eq(actors.orgId, ORG)))

	return { apply, setIssueSeverity, loadIssue, loadEvents, loadEscalations, loadAgents }
})

const withDb = <A, E>(self: Effect.Effect<A, E, Database>) =>
	self.pipe(Effect.provide(createTestDb(createdDbs).layer))

describe("severityRank / escalationReasonFor", () => {
	it("ranks severities and treats unset as lowest", () => {
		expect(severityRank("critical")).toBeGreaterThan(severityRank("high"))
		expect(severityRank("high")).toBeGreaterThan(severityRank("medium"))
		expect(severityRank("medium")).toBeGreaterThan(severityRank("low"))
		expect(severityRank("low")).toBeGreaterThan(severityRank(null))
	})

	it("escalates only on first set or strict upgrade", () => {
		expect(escalationReasonFor(null, "low")).toBe("severity_set")
		expect(escalationReasonFor("medium", "critical")).toBe("severity_escalated")
		expect(escalationReasonFor("medium", "medium")).toBeNull()
		expect(escalationReasonFor("critical", "low")).toBeNull()
	})
})

describe("applyTriageSeverity", () => {
	it.effect("applies severity, writes the timeline event, and queues an escalation", () =>
		withDb(
			Effect.gen(function* () {
				const t = yield* setup
				const outcome = yield* t.apply()
				expect(outcome.applied).toBe(true)
				expect(outcome.actorId).not.toBeNull()

				const issue = yield* t.loadIssue
				expect(issue?.severity).toBe("high")
				expect(issue?.severitySource).toBe("ai")

				const events = yield* t.loadEvents
				expect(events).toHaveLength(1)
				expect(events[0]?.type).toBe("severity_change")
				expect(events[0]?.payloadJson).toMatchObject({ from: null, to: "high", source: "ai" })

				const escalations = yield* t.loadEscalations
				expect(escalations).toHaveLength(1)
				expect(escalations[0]?.reason).toBe("severity_set")
				expect(escalations[0]?.status).toBe("queued")

				const agentRows = yield* t.loadAgents
				expect(agentRows).toHaveLength(1)
				expect(agentRows[0]?.agentName).toBe(TRIAGE_AGENT_NAME)
			}),
		),
	)

	it.effect("stamps the triage agent actor with the input timestamp, not wall clock", () =>
		withDb(
			Effect.gen(function* () {
				const t = yield* setup
				const timestamp = 1_765_432_100_000
				yield* t.apply({ timestamp })

				const agentRows = yield* t.loadAgents
				expect(agentRows).toHaveLength(1)
				expect(agentRows[0]?.createdAt.getTime()).toBe(timestamp)
				expect(agentRows[0]?.lastActiveAt?.getTime()).toBe(timestamp)
			}),
		),
	)

	it.effect("is idempotent across persist retries", () =>
		withDb(
			Effect.gen(function* () {
				const t = yield* setup
				yield* t.apply()
				yield* t.apply()

				expect(yield* t.loadEvents).toHaveLength(1)
				expect(yield* t.loadEscalations).toHaveLength(1)
			}),
		),
	)

	it.effect("never clobbers a manual override", () =>
		withDb(
			Effect.gen(function* () {
				const t = yield* setup
				yield* t.setIssueSeverity("low", "manual")

				const outcome = yield* t.apply()
				expect(outcome.applied).toBe(false)

				const issue = yield* t.loadIssue
				expect(issue?.severity).toBe("low")
				expect(issue?.severitySource).toBe("manual")

				expect(yield* t.loadEscalations).toHaveLength(0)
			}),
		),
	)

	/**
	 * The partial: a validator that promoted nothing has no cause whose severity it
	 * could assess, so the report omits the field. Before it was optional the agent
	 * had to fabricate a level here, and an inconclusive run could quietly downgrade
	 * an issue a detector had already ranked.
	 */
	it.effect("leaves the issue untouched when the report carried no assessment", () =>
		withDb(
			Effect.gen(function* () {
				const t = yield* setup
				yield* t.setIssueSeverity("critical", "detector")

				const outcome = yield* t.apply({ severity: undefined })
				expect(outcome.applied).toBe(false)
				// The actor still comes back: the caller records that triage ran.
				expect(outcome.actorId).not.toBeNull()

				const issue = yield* t.loadIssue
				expect(issue?.severity).toBe("critical")
				expect(issue?.severitySource).toBe("detector")

				expect(yield* t.loadEscalations).toHaveLength(0)
			}),
		),
	)

	it.effect("does not queue an escalation for a non-upward assessment", () =>
		withDb(
			Effect.gen(function* () {
				const t = yield* setup
				yield* t.setIssueSeverity("critical", "detector")

				const outcome = yield* t.apply({ severity: "medium" })
				expect(outcome.applied).toBe(true)

				const issue = yield* t.loadIssue
				expect(issue?.severity).toBe("medium")
				expect(issue?.severitySource).toBe("ai")

				expect(yield* t.loadEscalations).toHaveLength(0)
			}),
		),
	)

	it.effect(
		"flips the source detector->ai without a severity_change event when severity is unchanged",
		() =>
			withDb(
				Effect.gen(function* () {
					const t = yield* setup
					yield* t.setIssueSeverity("high", "detector")

					const outcome = yield* t.apply({ severity: "high" })
					expect(outcome.applied).toBe(true)

					const issue = yield* t.loadIssue
					expect(issue?.severity).toBe("high")
					expect(issue?.severitySource).toBe("ai")

					const events = yield* t.loadEvents
					expect(events.some((e) => e.type === "severity_change")).toBe(false)

					// Same-level confirmation: no escalation either (upward-only rule).
					expect(yield* t.loadEscalations).toHaveLength(0)
				}),
			),
	)

	it.effect("snapshots the full triage result into the escalation payload", () =>
		withDb(
			Effect.gen(function* () {
				const t = yield* setup
				const plainResult = {
					summary: "Error rate spike caused by a bad deploy.",
					suspectedCause: "Regression in payment-service v2.3.1.",
					severityAssessment: "high",
					affectedScope: "checkout-api, ~10% of requests",
					evidence: [
						{
							traceIds: ["0af7651916cd43dd8448eb211c80319c"],
							logPatterns: ["timeout after <num>ms"],
							relatedServices: ["payment-service"],
							note: "Consistent failure span.",
						},
					],
					suggestedActions: ["Roll back payment-service."],
					confidence: "medium",
				}
				const outcome = yield* t.apply({ result: decodeTriageResult(plainResult) })
				expect(outcome.applied).toBe(true)

				const escalations = yield* t.loadEscalations
				expect(escalations).toHaveLength(1)
				expect(escalations[0]?.payloadJson).toMatchObject({
					confidence: "medium",
					triage: plainResult,
				})
			}),
		),
	)

	it.effect("returns applied=false when the issue does not exist", () =>
		withDb(
			Effect.gen(function* () {
				const t = yield* setup
				const outcome = yield* t.apply({ issueId: asIssueId(randomUUID()) })
				expect(outcome.applied).toBe(false)
				expect(outcome.actorId).toBeNull()
			}),
		),
	)
})
