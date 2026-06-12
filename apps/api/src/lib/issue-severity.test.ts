import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { actors, errorIssues, errorIssueEvents, issueEscalations, runMigrations } from "@maple/db"
import { createMapleLibsqlClient, type MapleD1Client } from "@maple/db/client"
import { eq } from "drizzle-orm"
import { cleanupTempDirs, createTempDbUrl } from "@/lib/test-sqlite"
import {
	applyTriageSeverity,
	escalationReasonFor,
	severityRank,
	TRIAGE_AGENT_NAME,
} from "./issue-severity"

const createdTempDirs: string[] = []

afterEach(() => {
	cleanupTempDirs(createdTempDirs)
})

const ORG = "org_severity_test"

let db: MapleD1Client
let issueId: string

beforeEach(async () => {
	const { url } = createTempDbUrl("maple-issue-severity-", createdTempDirs)
	await runMigrations({ url })
	// Same shared drizzle query-builder surface as the D1 client.
	db = createMapleLibsqlClient({ url }) as unknown as MapleD1Client
	issueId = randomUUID()
	const now = Date.now()
	await db.insert(errorIssues).values({
		id: issueId as never,
		orgId: ORG as never,
		fingerprintHash: "12345678901234567890",
		serviceName: "checkout-api",
		exceptionType: "TimeoutError",
		exceptionMessage: "upstream timed out",
		topFrame: "",
		firstSeenAt: now,
		lastSeenAt: now,
		createdAt: now,
		updatedAt: now,
	})
})

const baseInput = (overrides: Partial<Parameters<typeof applyTriageSeverity>[1]> = {}) => ({
	orgId: ORG as never,
	issueId: issueId as never,
	runId: "run-1",
	severity: "high" as const,
	confidence: "medium" as const,
	timestamp: Date.now(),
	...overrides,
})

const loadIssue = async () => {
	const rows = await db
		.select()
		.from(errorIssues)
		.where(eq(errorIssues.id, issueId as never))
	return rows[0]
}

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
	it("applies severity, writes the timeline event, and queues an escalation", async () => {
		const outcome = await applyTriageSeverity(db, baseInput())
		expect(outcome.applied).toBe(true)
		expect(outcome.actorId).not.toBeNull()

		const issue = await loadIssue()
		expect(issue?.severity).toBe("high")
		expect(issue?.severitySource).toBe("ai")

		const events = await db
			.select()
			.from(errorIssueEvents)
			.where(eq(errorIssueEvents.issueId, issueId as never))
		expect(events).toHaveLength(1)
		expect(events[0]?.type).toBe("severity_change")
		const payload = JSON.parse(events[0]?.payloadJson ?? "{}")
		expect(payload.from).toBeNull()
		expect(payload.to).toBe("high")
		expect(payload.source).toBe("ai")

		const escalations = await db
			.select()
			.from(issueEscalations)
			.where(eq(issueEscalations.issueId, issueId as never))
		expect(escalations).toHaveLength(1)
		expect(escalations[0]?.reason).toBe("severity_set")
		expect(escalations[0]?.status).toBe("queued")

		const agentRows = await db.select().from(actors).where(eq(actors.orgId, ORG as never))
		expect(agentRows).toHaveLength(1)
		expect(agentRows[0]?.agentName).toBe(TRIAGE_AGENT_NAME)
	})

	it("is idempotent across persist retries", async () => {
		await applyTriageSeverity(db, baseInput())
		await applyTriageSeverity(db, baseInput())

		const events = await db
			.select()
			.from(errorIssueEvents)
			.where(eq(errorIssueEvents.issueId, issueId as never))
		expect(events).toHaveLength(1)
		const escalations = await db
			.select()
			.from(issueEscalations)
			.where(eq(issueEscalations.issueId, issueId as never))
		expect(escalations).toHaveLength(1)
	})

	it("never clobbers a manual override", async () => {
		await db
			.update(errorIssues)
			.set({ severity: "low", severitySource: "manual" })
			.where(eq(errorIssues.id, issueId as never))

		const outcome = await applyTriageSeverity(db, baseInput())
		expect(outcome.applied).toBe(false)

		const issue = await loadIssue()
		expect(issue?.severity).toBe("low")
		expect(issue?.severitySource).toBe("manual")

		const escalations = await db
			.select()
			.from(issueEscalations)
			.where(eq(issueEscalations.issueId, issueId as never))
		expect(escalations).toHaveLength(0)
	})

	it("does not queue an escalation for a non-upward assessment", async () => {
		await db
			.update(errorIssues)
			.set({ severity: "critical", severitySource: "detector" })
			.where(eq(errorIssues.id, issueId as never))

		const outcome = await applyTriageSeverity(db, baseInput({ severity: "medium" }))
		expect(outcome.applied).toBe(true)

		const issue = await loadIssue()
		expect(issue?.severity).toBe("medium")
		expect(issue?.severitySource).toBe("ai")

		const escalations = await db
			.select()
			.from(issueEscalations)
			.where(eq(issueEscalations.issueId, issueId as never))
		expect(escalations).toHaveLength(0)
	})

	it("returns applied=false when the issue does not exist", async () => {
		const outcome = await applyTriageSeverity(db, baseInput({ issueId: randomUUID() as never }))
		expect(outcome.applied).toBe(false)
		expect(outcome.actorId).toBeNull()
	})
})
