import * as Policy from "@maple/domain/policy"
import { describe, expect, it } from "vitest"
import { Context, Effect, Layer, Schema } from "effect"
import {
	ActorId,
	ErrorIssueDocument,
	ErrorIssueGroupingResponse,
	ErrorIssueId,
	ErrorIssueNotFoundError,
	ErrorIssueSimilarResponse,
	ErrorValidationError,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import {
	DetachErrorFingerprintOutput,
	ExplainErrorGroupingOutput,
	ListSimilarErrorIssuesOutput,
} from "@maple/domain/mcp-outputs"
import { ErrorGroupingService } from "@maple/backend/services/errors/ErrorGroupingService"
import { ErrorIssueMergeService } from "@maple/backend/services/errors/ErrorIssueMergeService"
import { CurrentMcpTenant } from "../../tenant"
import { executeRegisteredMcpToolUnscoped } from "../registry"
import type { McpToolResult } from "../types"

const ORG = Schema.decodeSync(OrgId)("org_error_grouping")
const ISSUE = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const ACTOR = Schema.decodeSync(ActorId)("33333333-3333-4333-8333-333333333333")

const grouping = Schema.decodeSync(ErrorIssueGroupingResponse)({
	fingerprints: [
		{
			fingerprintHash: "100",
			source: "primary",
			rule: "type-message",
			orgRule: null,
			pinned: false,
			exceptionType: "TypeError",
			messageSignature: "cart is undefined",
			frames: [],
			skippedFrames: [],
			customKey: null,
			sampledAt: "2026-11-20T10:00:00.000Z",
		},
		{
			fingerprintHash: "200",
			source: "group",
			rule: "type-function",
			orgRule: null,
			pinned: false,
			exceptionType: "TypeError",
			messageSignature: "",
			frames: ["applyDiscount"],
			skippedFrames: ["node_modules/react/index.js"],
			customKey: null,
			sampledAt: null,
		},
	],
	truncated: false,
})

const similar = Schema.decodeSync(ErrorIssueSimilarResponse)({
	issues: [
		{
			id: OTHER,
			serviceName: "checkout-api",
			exceptionType: "TypeError",
			exceptionMessage: "cart is undefined in applyDiscount",
			errorLabel: "TypeError: cart is undefined",
			workflowState: "triage",
			occurrenceCount: 12,
			lastSeenAt: "2026-11-21T10:00:00.000Z",
			similarity: 0.75,
		},
	],
})

const issueDoc = (fingerprintHashes: ReadonlyArray<string>) =>
	Schema.decodeSync(ErrorIssueDocument)({
		id: ISSUE,
		kind: "error",
		fingerprintHash: "100",
		fingerprintHashes,
		serviceName: "checkout-api",
		exceptionType: "TypeError",
		exceptionMessage: "cart is undefined",
		errorLabel: "TypeError: cart is undefined",
		topFrame: "applyDiscount",
		workflowState: "triage",
		priority: 0,
		severity: null,
		severitySource: null,
		sourceRef: null,
		assignedActor: null,
		leaseHolder: null,
		leaseExpiresAt: null,
		claimedAt: null,
		notes: null,
		firstSeenAt: "2026-11-01T10:00:00.000Z",
		lastSeenAt: "2026-11-21T10:00:00.000Z",
		occurrenceCount: 40,
		resolvedAt: null,
		lastResolvedAt: null,
		lastRegressedAt: null,
		regressionCount: 0,
		resolvedVersions: [],
		snoozeUntil: null,
		archivedAt: null,
		mergedIntoIssueId: null,
		hasOpenIncident: false,
		commentCount: 0,
		openPullRequestCount: 0,
		mergedPullRequestCount: 0,
	})

const notFound = (issueId: ErrorIssueId) =>
	new ErrorIssueNotFoundError({ message: `No such issue: ${issueId}`, issueId })

type Seen = { orgId?: string; issueId?: string; actorId?: string; hash?: string }

const groupingService = (seen: Seen, known = true) =>
	Layer.mock(ErrorGroupingService)({
		explainIssue: (orgId, issueId) => {
			seen.orgId = orgId
			seen.issueId = issueId
			return known ? Effect.succeed(grouping) : Effect.fail(notFound(issueId))
		},
		similarIssues: (orgId, issueId) => {
			seen.orgId = orgId
			seen.issueId = issueId
			return known ? Effect.succeed(similar) : Effect.fail(notFound(issueId))
		},
	})

const mergeService = (seen: Seen) =>
	Layer.mock(ErrorIssueMergeService)({
		detachFingerprint: (orgId, actorId, issueId, hash) => {
			seen.orgId = orgId
			seen.actorId = actorId
			seen.issueId = issueId
			seen.hash = hash
			return hash === "200"
				? Effect.succeed(issueDoc(["100"]))
				: Effect.fail(
						new ErrorValidationError({
							message: "This fingerprint came from a merge; unmerge it instead.",
							details: [],
						}),
					)
		},
	})

// actorId pins the acting agent, so the tool never reaches the actors service.
const tenant = Layer.succeed(CurrentMcpTenant, {
	orgId: ORG,
	userId: Schema.decodeSync(UserId)("user_error_grouping"),
	roles: [Schema.decodeSync(RoleName)("org:member")],
	permissions: Policy.grantsOf(["org:member"]),
	authMode: "self_hosted",
	actorId: ACTOR,
})

const withoutUnreachedServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
	Effect.provide(effect, Context.makeUnsafe<R>(new Map()))

const run = <S>(tool: string, params: unknown, layer: Layer.Layer<S>) =>
	Effect.runPromise(
		executeRegisteredMcpToolUnscoped(tool, params, "mcp").pipe(
			Effect.provide(Layer.merge(layer, tenant)),
			Effect.result,
			withoutUnreachedServices,
		),
	)

const ok = async <S>(tool: string, params: unknown, layer: Layer.Layer<S>): Promise<McpToolResult> => {
	const result = await run(tool, params, layer)
	if (result._tag !== "Success") throw new Error(`${tool} failed: ${JSON.stringify(result.failure)}`)
	return result.success
}

const failureTag = async <S>(tool: string, params: unknown, layer: Layer.Layer<S>) => {
	const result = await run(tool, params, layer)
	return result._tag === "Failure" ? result.failure._tag : undefined
}

const text = (result: McpToolResult) => result.content[0]?.text ?? ""

describe("explain_error_grouping", () => {
	it("explains each fingerprint's source and rule and suggests detaching the grouped one", async () => {
		const seen: Seen = {}
		const result = await ok("explain_error_grouping", { issue_id: ISSUE }, groupingService(seen))
		expect(seen).toEqual({ orgId: ORG, issueId: ISSUE })

		const output = Schema.decodeUnknownSync(ExplainErrorGroupingOutput)(result.structuredContent)
		expect(output.fingerprints.map((fp) => fp.source)).toEqual(["primary", "group"])

		const markdown = text(result)
		expect(markdown).toContain("type-message: same error type and message")
		expect(markdown).toContain("type-function: same type, first named function applyDiscount")
		expect(markdown).toContain("node_modules/react/index.js")
		expect(markdown).toContain(`detach_error_fingerprint issue_id="${ISSUE}" fingerprint="200"`)
		expect(markdown).not.toContain('fingerprint="100"')
		expect(markdown).toContain(`list_similar_error_issues issue_id="${ISSUE}"`)
	})

	it("reports an unknown issue as invalid input", async () => {
		expect(
			await failureTag("explain_error_grouping", { issue_id: ISSUE }, groupingService({}, false)),
		).toBe("@maple/mcp/errors/McpInvalidInputError")
	})
})

describe("list_similar_error_issues", () => {
	it("lists suggested duplicates and offers a merge only as a checked next step", async () => {
		const result = await ok("list_similar_error_issues", { issue_id: ISSUE }, groupingService({}))
		const output = Schema.decodeUnknownSync(ListSimilarErrorIssuesOutput)(result.structuredContent)
		expect(output.issues.map((issue) => issue.id)).toEqual([OTHER])

		const markdown = text(result)
		expect(markdown).toContain("75%")
		expect(markdown).toContain("merge_error_issues")
		expect(markdown).toContain("same root cause")
	})
})

describe("detach_error_fingerprint", () => {
	it("detaches a grouped fingerprint as the pinned actor", async () => {
		const seen: Seen = {}
		const result = await ok(
			"detach_error_fingerprint",
			{ issue_id: ISSUE, fingerprint: " 200 " },
			mergeService(seen),
		)
		expect(seen).toEqual({ orgId: ORG, actorId: ACTOR, issueId: ISSUE, hash: "200" })
		const output = Schema.decodeUnknownSync(DetachErrorFingerprintOutput)(result.structuredContent)
		expect(output.detachedFingerprintHash).toBe("200")
		expect(output.fingerprintHashes).toEqual(["100"])
	})

	it("passes the service's refusal of a merged fingerprint back as invalid input", async () => {
		const result = await run(
			"detach_error_fingerprint",
			{ issue_id: ISSUE, fingerprint: "300" },
			mergeService({}),
		)
		const failure = result._tag === "Failure" ? result.failure : undefined
		expect(failure?._tag).toBe("@maple/mcp/errors/McpInvalidInputError")
		expect(failure?.message).toContain("unmerge")
	})
})
