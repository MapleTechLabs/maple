import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { generateText } from "ai"
import { aiTriageRuns, aiTriageSettings, errorIssueEvents, runMigrations } from "@maple/db"
import { createMapleLibsqlClient, type MapleD1Client } from "@maple/db/client"
import { eq } from "drizzle-orm"
import { cleanupTempDirs, createTempDbUrl } from "@/lib/test-sqlite"
import { runAiTriage, type AiTriageWorkflowPayload } from "./AiTriageWorkflow.run"
import type { WorkflowStepLike } from "./ClickHouseSchemaApplyWorkflow.run"

const createdTempDirs: string[] = []

afterEach(() => {
	cleanupTempDirs(createdTempDirs)
})

// Pass-through step harness: every step.do just runs its callback.
const fakeStep: WorkflowStepLike = {
	do: (async (_name: string, configOrCb: unknown, cb?: () => Promise<unknown>) =>
		(cb ?? (configOrCb as () => Promise<unknown>))()) as WorkflowStepLike["do"],
}

const ORG = "org_triage_test"

const validResult = {
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
	confidence: "high",
}

const fakeGenerate = (toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>) =>
	(async () => ({
		steps: [{ toolCalls }],
		totalUsage: { inputTokens: 120, outputTokens: 60 },
		text: "",
	})) as unknown as typeof generateText

interface Harness {
	readonly db: MapleD1Client
	readonly runId: string
	readonly issueId: string
	readonly payload: AiTriageWorkflowPayload
}

let harness: Harness

beforeEach(async () => {
	const { url } = createTempDbUrl("maple-ai-triage-run-", createdTempDirs)
	await runMigrations({ url })
	// The workflow only uses the shared drizzle query-builder surface, which the
	// libsql and D1 clients implement identically.
	const db = createMapleLibsqlClient({ url }) as unknown as MapleD1Client
	const runId = randomUUID()
	const issueId = randomUUID()
	const incidentId = randomUUID()
	const now = Date.now()

	await db.insert(aiTriageSettings).values({
		orgId: ORG as never,
		enabled: 1,
		maxRunsPerDay: 20,
		updatedAt: now,
	})
	await db.insert(aiTriageRuns).values({
		id: runId as never,
		orgId: ORG as never,
		incidentKind: "error",
		incidentId,
		issueId: issueId as never,
		status: "queued",
		contextJson: JSON.stringify({ kind: "error", serviceName: "checkout-api" }),
		createdAt: now,
		updatedAt: now,
	})

	harness = {
		db,
		runId,
		issueId,
		payload: {
			orgId: ORG,
			incidentKind: "error",
			incidentId,
			issueId,
			runId,
		},
	}
})

const env = { MAPLE_DB: undefined, INTERNAL_SERVICE_TOKEN: "test-token" }

const loadRun = async () => {
	const rows = await harness.db
		.select()
		.from(aiTriageRuns)
		.where(eq(aiTriageRuns.id, harness.runId as never))
		.limit(1)
	return rows[0]
}

describe("runAiTriage", () => {
	it("completes the run, stores the result, and writes the issue timeline event", async () => {
		const result = await runAiTriage(env, { payload: harness.payload }, fakeStep, {
			db: harness.db,
			resolveApiKey: async () => "test-key",
			generate: fakeGenerate([{ toolName: "submit_triage", input: validResult }]),
		})
		expect(result.status).toBe("completed")

		const run = await loadRun()
		expect(run?.status).toBe("completed")
		expect(run?.inputTokens).toBe(120)
		expect(run?.outputTokens).toBe(60)
		expect(JSON.parse(run?.resultJson ?? "{}").summary).toContain("bad deploy")

		const events = await harness.db
			.select()
			.from(errorIssueEvents)
			.where(eq(errorIssueEvents.issueId, harness.issueId as never))
		expect(events).toHaveLength(1)
		expect(events[0]?.type).toBe("ai_triage")
		expect(JSON.parse(events[0]?.payloadJson ?? "{}").runId).toBe(harness.runId)
	})

	it("is a no-op replay when the run already progressed", async () => {
		await harness.db
			.update(aiTriageRuns)
			.set({ status: "completed" })
			.where(eq(aiTriageRuns.id, harness.runId as never))

		const result = await runAiTriage(env, { payload: harness.payload }, fakeStep, {
			db: harness.db,
			resolveApiKey: async () => "test-key",
			generate: fakeGenerate([{ toolName: "submit_triage", input: validResult }]),
		})
		expect(result.status).toBe("skipped")
	})

	it("fails the run when the agent never calls submit_triage", async () => {
		const result = await runAiTriage(env, { payload: harness.payload }, fakeStep, {
			db: harness.db,
			resolveApiKey: async () => "test-key",
			generate: fakeGenerate([{ toolName: "diagnose_service", input: {} }]),
		})
		expect(result.status).toBe("failed")
		const run = await loadRun()
		expect(run?.status).toBe("failed")
		expect(run?.error).toBe("no_structured_result")
	})

	it("fails fast without an OpenRouter key", async () => {
		const result = await runAiTriage(env, { payload: harness.payload }, fakeStep, {
			db: harness.db,
			resolveApiKey: async () => undefined,
			generate: fakeGenerate([{ toolName: "submit_triage", input: validResult }]),
		})
		expect(result.status).toBe("failed")
		const run = await loadRun()
		expect(run?.status).toBe("failed")
		expect(run?.error).toBe("no_openrouter_key")
	})
})
