import { describe, expect, it } from "vitest"
import { Context, Effect, Layer, Schema } from "effect"
import {
	InvestigationDocument,
	InvestigationNotFoundError,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { GetInvestigationOutput } from "@maple/domain/mcp-outputs"
import { InvestigationService } from "@maple/backend/services/errors/InvestigationService"
import { CurrentMcpTenant } from "../../lib/query-warehouse"
import { executeRegisteredMcpToolUnscoped } from "../registry"
import type { McpToolResult } from "../types"

const ORG = Schema.decodeSync(OrgId)("org_get_investigation")
const INVESTIGATION_UUID = "0190f2b3-4d5e-7f70-8192-a3b4c5d6e7f8"
const INVESTIGATION_PUBLIC = encodePublicId(PublicIdPrefixes.investigation, INVESTIGATION_UUID)
const ISSUE_UUID = "55555555-5555-4555-8555-555555555555"
const ISSUE_PUBLIC = encodePublicId(PublicIdPrefixes.errorIssue, ISSUE_UUID)
const TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"
const FINGERPRINT = "11640295108927840024"

const snapshot = {
	title: "TypeError in checkout-api",
	scope: "checkout-api",
	status: "open",
	severity: "high",
	facts: [{ label: "Occurrences", value: "42" }],
	references: [],
	incidentStartedAt: "2026-11-01T09:00:00.000Z",
	incidentEndedAt: null,
	fingerprintHash: FINGERPRINT,
	exceptionType: "TypeError",
	exceptionMessage: "cart is undefined",
	topFrame: "applyDiscount (src/cart.ts:42)",
	serviceName: "checkout-api",
	deploymentEnv: "production",
}

const diagnosed = Schema.decodeUnknownSync(InvestigationDocument)({
	id: INVESTIGATION_UUID,
	status: "diagnosed",
	subject: {
		type: "incident",
		incidentKind: "error",
		incidentId: "018f2b3c-4d5e-6f70-8192-a3b4c5d6e7f8",
		issueId: ISSUE_UUID,
	},
	snapshot,
	report: {
		headline: "Deploy 4f21a dropped the cart null check",
		summary: "applyDiscount reads cart before the session loads it.",
		suspectedCause: "Deploy 4f21a removed the guard on an unloaded cart.",
		severityAssessment: "high",
		affectedScope: "checkout-api, POST /checkout",
		evidence: [
			{
				traceIds: [TRACE_ID],
				logPatterns: ["cart is undefined"],
				relatedServices: ["cart-service"],
				note: "Every failing trace starts after the deploy",
			},
		],
		suggestedActions: ["Restore the null check in applyDiscount."],
		confidence: "high",
		ruledOut: ["cart-service latency: p99 flat"],
		suspectCommit: { sha: "4f21a9c", repo: "acme/checkout-api" },
	},
	progress: null,
	model: "claude-opus-4-8",
	severity: "high",
	confidence: "high",
	seededBy: "system",
	createdBy: null,
	inputTokens: 1000,
	outputTokens: 200,
	error: null,
	createdAt: "2026-11-01T09:01:00.000Z",
	startedAt: "2026-11-01T09:01:05.000Z",
	diagnosedAt: "2026-11-01T09:03:00.000Z",
	updatedAt: "2026-11-01T09:03:00.000Z",
})

const running = Schema.decodeUnknownSync(InvestigationDocument)({
	...Schema.encodeSync(InvestigationDocument)(diagnosed),
	status: "investigating",
	subject: {
		type: "freeform",
		title: "Why is checkout slow?",
		prompt: "Why is checkout slow?",
		contextRefs: [],
	},
	snapshot: { ...snapshot, fingerprintHash: null },
	report: null,
	diagnosedAt: null,
})

type Seen = { orgId?: string; id?: string }

const service = (seen: Seen, doc: InvestigationDocument | null) =>
	Layer.mock(InvestigationService)({
		getInvestigation: (orgId, id) => {
			seen.orgId = orgId
			seen.id = id
			return doc === null
				? Effect.fail(new InvestigationNotFoundError({ message: `No such investigation: '${id}'` }))
				: Effect.succeed(doc)
		},
	})

const tenant = Layer.succeed(CurrentMcpTenant, {
	orgId: ORG,
	userId: Schema.decodeSync(UserId)("user_get_investigation"),
	roles: [Schema.decodeSync(RoleName)("org:member")],
	authMode: "self_hosted",
})

// The registry's requirements name every tool's services; this tool reaches only the investigation read.
const withoutUnreachedServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
	Effect.provide(effect, Context.makeUnsafe<R>(new Map()))

const run = (params: unknown, layer: Layer.Layer<InvestigationService>) =>
	Effect.runPromise(
		executeRegisteredMcpToolUnscoped("get_investigation", params, "mcp").pipe(
			Effect.provide(Layer.merge(layer, tenant)),
			Effect.result,
			withoutUnreachedServices,
		),
	)

const ok = async (params: unknown, layer: Layer.Layer<InvestigationService>) => {
	const result = await run(params, layer)
	if (result._tag !== "Success")
		throw new Error(`get_investigation failed: ${JSON.stringify(result.failure)}`)
	return result.success
}

const text = (result: McpToolResult) => result.content[0]?.text ?? ""

describe("get_investigation", () => {
	it("reads a diagnosed investigation by its inv_ id in the caller's org", async () => {
		const seen: Seen = {}
		const result = await ok({ investigation_id: INVESTIGATION_PUBLIC }, service(seen, diagnosed))
		expect(seen).toEqual({ orgId: ORG, id: INVESTIGATION_UUID })

		const output = Schema.decodeUnknownSync(GetInvestigationOutput)(result.structuredContent)
		expect(output.id).toBe(INVESTIGATION_PUBLIC)
		expect(output.subject.issueId).toBe(ISSUE_PUBLIC)
		expect(output.snapshot.fingerprintHash).toBe(FINGERPRINT)
		expect(output.report?.evidence[0]?.traceIds).toEqual([TRACE_ID])
		expect(output.report?.unchecked).toEqual([])
		expect(output.report?.suspectCommit).toEqual({ sha: "4f21a9c", repo: "acme/checkout-api" })

		const markdown = text(result)
		expect(markdown).toContain("Deploy 4f21a removed the guard on an unloaded cart.")
		expect(markdown).toContain("Restore the null check in applyDiscount.")
		expect(markdown).toContain("cart-service latency: p99 flat")
		expect(markdown).toContain("4f21a9c in acme/checkout-api")
		expect(markdown).toContain(`inspect_trace trace_id="${TRACE_ID}"`)
		expect(markdown).toContain(`error_detail fingerprint="${FINGERPRINT}"`)
		expect(markdown).toContain(`claim_error_issue issue_id="${ISSUE_PUBLIC}"`)
		expect(markdown).toContain(`list_error_issue_events issue_id="${ISSUE_PUBLIC}"`)
	})

	it("accepts the raw UUID, also under the id alias", async () => {
		const seen: Seen = {}
		await ok({ investigation_id: INVESTIGATION_UUID }, service(seen, diagnosed))
		expect(seen.id).toBe(INVESTIGATION_UUID)

		const aliased: Seen = {}
		await ok({ id: INVESTIGATION_PUBLIC }, service(aliased, diagnosed))
		expect(aliased.id).toBe(INVESTIGATION_UUID)
	})

	it("returns a running investigation without a report, and suggests no trace or fingerprint", async () => {
		const result = await ok({ investigation_id: INVESTIGATION_PUBLIC }, service({}, running))
		const output = Schema.decodeUnknownSync(GetInvestigationOutput)(result.structuredContent)
		expect(output.status).toBe("investigating")
		expect(output.report).toBeNull()
		expect(output.subject.prompt).toBe("Why is checkout slow?")

		const markdown = text(result)
		expect(markdown).toContain("Still investigating")
		expect(markdown).not.toContain("inspect_trace")
		expect(markdown).not.toContain("error_detail")
	})

	it("reports an unknown investigation as invalid input", async () => {
		const result = await run({ investigation_id: INVESTIGATION_PUBLIC }, service({}, null))
		expect(result._tag === "Failure" ? result.failure._tag : undefined).toBe(
			"@maple/mcp/errors/McpInvalidInputError",
		)
	})

	it("refuses an id that is neither form without reading", async () => {
		const seen: Seen = {}
		const malformed = await run({ investigation_id: "not-an-id" }, service(seen, diagnosed))
		const otherResource = await run({ investigation_id: ISSUE_PUBLIC }, service(seen, diagnosed))
		expect(malformed._tag === "Failure" ? malformed.failure._tag : undefined).toBe(
			"@maple/mcp/errors/McpInvalidInputError",
		)
		expect(otherResource._tag === "Failure" ? otherResource.failure._tag : undefined).toBe(
			"@maple/mcp/errors/McpInvalidInputError",
		)
		expect(seen.id).toBeUndefined()
	})
})
