import {
	ErrorIssueClaimRequest,
	ErrorIssueId,
	ErrorIssueMergeRequest,
	ErrorIssueReleaseRequest,
	ErrorIssueSetSeverityRequest,
	ErrorIssueTransitionRequest,
	IssueSeverity,
	WorkflowState,
} from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { Effect, Exit, Schema, Array as Arr } from "effect"
import { LoadFailure, toLoadFailure } from "@maple/views/data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import { PageOutMessage } from "../../contract"
import { WORKFLOW_LABEL } from "../kit/workflow"

// `useIssueMutations` (components/errors/use-issue-mutations.ts): one row's write, or the bulk bar's
// over the selection, four at a time (`BULK_CONCURRENCY`), each issue's outcome kept.

export const HubWrite = Schema.Union([
	Schema.TaggedStruct("Transition", { toState: WorkflowState }),
	Schema.TaggedStruct("Claim", {}),
	Schema.TaggedStruct("Release", {}),
	Schema.TaggedStruct("SetSeverity", { severity: Schema.NullOr(IssueSeverity) }),
	/** The written ids fold into `targetId`, in one request. */
	Schema.TaggedStruct("Merge", { targetId: ErrorIssueId }),
])
export type HubWrite = typeof HubWrite.Type

/** How a write went: how many issues took it, and the first failure's body. */
export const WriteOutcome = Schema.Struct({
	succeeded: Schema.Number,
	failed: Schema.Number,
	firstFailure: Schema.NullOr(LoadFailure),
})
export type WriteOutcome = typeof WriteOutcome.Type

const writeOne = (
	issueId: ErrorIssueId,
	write: Exclude<HubWrite, { readonly _tag: "Merge" }>,
	expectedState: WorkflowState | undefined,
) =>
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		const params = { issueId }
		switch (write._tag) {
			case "Transition":
				return yield* client.errors.transitionIssue({
					params,
					payload: new ErrorIssueTransitionRequest({
						toState: write.toState,
						...(expectedState === undefined ? undefined : { expectedState }),
					}),
				})
			case "Claim":
				return yield* client.errors.claimIssue({ params, payload: new ErrorIssueClaimRequest({}) })
			case "Release":
				return yield* client.errors.releaseIssue({
					params,
					payload: new ErrorIssueReleaseRequest({}),
				})
			case "SetSeverity":
				return yield* client.errors.setIssueSeverity({
					params,
					payload: new ErrorIssueSetSeverityRequest({ severity: write.severity }),
				})
		}
	})

/** A merge is one request for the whole set: it commits for every issue or for none. */
const mergeAll = (targetId: ErrorIssueId, ids: ReadonlyArray<ErrorIssueId>) =>
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		return yield* client.errors.mergeIssues({
			params: { issueId: targetId },
			payload: new ErrorIssueMergeRequest({ sourceIssueIds: ids }),
		})
	})

/** Builds the Command for the page's own completion Message (`CompletedHubWrite`). */
export const runHubWrite = <M>(
	ids: ReadonlyArray<ErrorIssueId>,
	write: HubWrite,
	expectedStates: Readonly<Record<string, WorkflowState>>,
	toMessage: (outcome: WriteOutcome) => M,
) =>
	(write._tag === "Merge"
		? Effect.exit(mergeAll(write.targetId, ids)).pipe(
				Effect.map((exit) => Arr.replicate(exit, ids.length)),
			)
		: Effect.forEach(ids, (id) => Effect.exit(writeOne(id, write, expectedStates[id])), {
				concurrency: 4,
			})
	).pipe(
		Effect.map((exits) => {
			const failures = Arr.filter(exits, Exit.isFailure)
			const first = failures[0]
			return toMessage({
				succeeded: ids.length - failures.length,
				failed: failures.length,
				firstFailure: first === undefined ? null : toLoadFailure(first),
			})
		}),
	)

const toast = (type: "success" | "error" | "warning", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

/** A single row's write: `toastExit` with the row's titles. */
const singleToast = (write: HubWrite, outcome: WriteOutcome) => {
	const failure = outcome.firstFailure
	switch (write._tag) {
		case "Transition":
			return failure === null
				? toast("success", `Moved to ${WORKFLOW_LABEL[write.toState]}`)
				: toast("error", "State change failed", failure.message)
		case "Claim":
			return failure === null
				? toast("success", "Claimed")
				: toast("error", "Claim failed", failure.message)
		case "Release":
			return failure === null
				? toast("success", "Released")
				: toast("error", "Release failed", failure.message)
		case "SetSeverity":
			return failure === null
				? toast(
						"success",
						write.severity === null ? "Severity cleared" : `Severity set to ${write.severity}`,
					)
				: toast("error", "Severity change failed", failure.message)
		case "Merge":
			return failure === null
				? toast("success", "Merged")
				: toast("error", "Merge failed", failure.message)
	}
}

const bulkDone = (write: HubWrite, total: number): string => {
	switch (write._tag) {
		case "Transition":
			return `Moved ${total} to ${WORKFLOW_LABEL[write.toState]}`
		case "Claim":
			return `Claimed ${countLabel(total, "issue")}`
		case "Release":
			return `Released ${countLabel(total, "issue")}`
		case "SetSeverity":
			return `Updated severity for ${countLabel(total, "issue")}`
		case "Merge":
			return `Merged ${countLabel(total, "issue")}`
	}
}

const bulkPartial = (write: HubWrite, outcome: WriteOutcome, total: number): string => {
	const tail = `${outcome.succeeded} of ${total}; ${outcome.failed} failed`
	switch (write._tag) {
		case "Transition":
			return `Moved ${tail}`
		case "Claim":
			return `Claimed ${tail}`
		case "Release":
			return `Released ${tail}`
		case "SetSeverity":
			return `Updated ${tail}`
		case "Merge":
			return `Merged ${tail}`
	}
}

const BULK_FAILED = {
	Transition: "State change failed",
	Claim: "Claim failed",
	Release: "Release failed",
	SetSeverity: "Severity change failed",
	Merge: "Merge failed",
} satisfies Record<HubWrite["_tag"], string>

/** `transitionMany` and friends: all, some (a warning), or none. */
export const outcomeToast = (write: HubWrite, outcome: WriteOutcome, isBulk: boolean) => {
	if (!isBulk) return singleToast(write, outcome)
	const total = outcome.succeeded + outcome.failed
	const message = outcome.firstFailure?.message ?? ""
	if (outcome.failed === 0) return toast("success", bulkDone(write, total))
	if (outcome.succeeded > 0) return toast("warning", bulkPartial(write, outcome, total), message)
	return toast("error", BULK_FAILED[write._tag], message)
}
