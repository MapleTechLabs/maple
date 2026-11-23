import {
	ErrorIssueFingerprintGrouping,
	ErrorIssueGroupingResponse,
	ErrorIssueId,
	ErrorIssueSimilarIssue,
	ErrorIssueSimilarResponse,
	IsoDateTimeString,
} from "@maple/domain/http"
import { Schema } from "effect"

// The error issue lab's Grouping tab: one issue's fingerprints under every rule and source, a
// pinned one, a long frame list, and the open issues that look like it.

export const GROUPING_STATES = ["populated", "long", "empty", "loading", "error"] as const
export type GroupingState = (typeof GROUPING_STATES)[number]

const issueId = Schema.decodeSync(ErrorIssueId)
const iso = Schema.decodeSync(IsoDateTimeString)

const fingerprint = (fields: Partial<ConstructorParameters<typeof ErrorIssueFingerprintGrouping>[0]>) =>
	new ErrorIssueFingerprintGrouping({
		fingerprintHash: "12660752272409977512",
		source: "primary",
		rule: "type-message",
		orgRule: null,
		pinned: false,
		exceptionType: "TypeError",
		messageSignature: "Cannot read properties of undefined (reading '<str>')",
		frames: [],
		skippedFrames: [],
		customKey: null,
		sampledAt: iso("2026-11-01T11:58:00.000Z"),
		...fields,
	})

const APP_FRAMES = [
	"    at resolvePlan (billing/plan.ts:42:28)",
	"    at SubscriptionService.renew (billing/subscription-service.ts:118:19)",
	"    at async handleRenewal (routes/renewals.ts:31:5)",
]

const LIBRARY_FRAMES = [
	"    at async compose (hono/dist/compose.js:30:17)",
	"    at async dispatch (hono/dist/hono-base.js:188:23)",
	"    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
]

/** One of each source and rule, with a pinned fingerprint that was split out and came back merged. */
export const populatedGrouping = new ErrorIssueGroupingResponse({
	truncated: false,
	fingerprints: [
		fingerprint({}),
		fingerprint({
			fingerprintHash: "8031945512867301184",
			source: "group",
			rule: "type-function",
			messageSignature: "",
			frames: [APP_FRAMES[0] ?? ""],
			skippedFrames: LIBRARY_FRAMES,
		}),
		fingerprint({
			fingerprintHash: "4412097833154620981",
			source: "merge",
			rule: "org-rule",
			orgRule: "Plan lookups on renewal",
			messageSignature: "Cannot read properties of null (reading '<str>')",
			pinned: true,
		}),
		fingerprint({
			fingerprintHash: "17322091604511128890",
			source: "group",
			rule: "frames",
			exceptionType: "Error",
			messageSignature: "plan missing for subscription <id>",
			frames: APP_FRAMES,
			skippedFrames: LIBRARY_FRAMES,
		}),
		fingerprint({
			fingerprintHash: "2290871135462209745",
			source: "rekey",
			rule: "custom",
			messageSignature: "",
			customKey: "billing.plan-missing",
		}),
		fingerprint({
			fingerprintHash: "9958817702213345566",
			source: "group",
			rule: null,
			messageSignature: "",
			sampledAt: null,
		}),
	],
})

/** A generic error keyed on a deep stack: every frame it read, and the dependency frames it passed over. */
export const longGrouping = new ErrorIssueGroupingResponse({
	truncated: true,
	fingerprints: [
		fingerprint({
			fingerprintHash: "5104883920017756310",
			rule: "frames",
			exceptionType: "Error",
			messageSignature:
				"upstream returned <num> for /v1/accounts/<id>/subscriptions/<id>/items?expand=<str>",
			frames: Array.from(
				{ length: 14 },
				(_, i) =>
					`    at step${i + 1}WithAVeryDescriptiveFunctionName (subscriptions-api/src/pipeline/stages/stage-${i + 1}-handlers.ts:${40 + i * 7}:${12 + i})`,
			),
			skippedFrames: [
				...LIBRARY_FRAMES,
				"    at Layer.handle [as handle_request] (express/lib/router/layer.js:95:5)",
				"    at next (express/lib/router/route.js:149:13)",
				"    at Route.dispatch (express/lib/router/route.js:119:3)",
			],
			pinned: true,
		}),
	],
})

export const emptyGrouping = new ErrorIssueGroupingResponse({ fingerprints: [], truncated: false })

export const populatedSimilar = new ErrorIssueSimilarResponse({
	issues: [
		new ErrorIssueSimilarIssue({
			id: issueId("0199a004-0000-7000-8000-000000000011"),
			serviceName: "subscriptions-api",
			exceptionType: "TypeError",
			exceptionMessage: "Cannot read properties of undefined (reading 'planId')",
			errorLabel: "TypeError",
			workflowState: "triage",
			occurrenceCount: 2_184,
			lastSeenAt: iso("2026-11-01T11:41:00.000Z"),
			similarity: 0.86,
		}),
		new ErrorIssueSimilarIssue({
			id: issueId("0199a004-0000-7000-8000-000000000012"),
			serviceName: "subscriptions-api",
			exceptionType: "TypeError",
			exceptionMessage:
				"Cannot read properties of undefined (reading 'plan') while renewing subscription sub_8f2k1 for account acct_02mxq in region eu-west-1",
			errorLabel: "TypeError",
			workflowState: "in_progress",
			occurrenceCount: 1,
			lastSeenAt: iso("2026-10-31T22:05:00.000Z"),
			similarity: 0.71,
		}),
		new ErrorIssueSimilarIssue({
			id: issueId("0199a004-0000-7000-8000-000000000013"),
			serviceName: "subscriptions-api",
			exceptionType: "TypeError",
			exceptionMessage: "Cannot read properties of null (reading 'tier')",
			errorLabel: "TypeError",
			workflowState: "todo",
			occurrenceCount: 96,
			lastSeenAt: iso("2026-10-29T08:12:00.000Z"),
			similarity: 0.5,
		}),
	],
})

export const emptySimilar = new ErrorIssueSimilarResponse({ issues: [] })
