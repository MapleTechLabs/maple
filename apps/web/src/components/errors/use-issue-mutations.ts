import { Effect, Exit } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"
import { useAtomSet } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	ErrorIssueClaimRequest,
	ErrorIssueReleaseRequest,
	ErrorIssueSetSeverityRequest,
	ErrorIssueTransitionRequest,
	type ErrorIssueId,
	type IssueSeverity,
	type WorkflowState,
} from "@maple/domain/http"
import { WORKFLOW_LABEL } from "@/components/icons/workflow-ring"
import { logClientError } from "@/lib/services/common/telemetry"
import { showErrorToast } from "@/lib/error-toast"
import { batchOutcome, forEachIssue, ISSUES_KEY, issueKey } from "./issue-batch"

const INVALIDATE = [ISSUES_KEY] as const

function logFailure(label: string, result: Exit.Exit<unknown, unknown>) {
	if (Exit.isSuccess(result)) return
	logClientError("issue.mutation_failed", result.cause, {
		"maple.issue.mutation": label,
	})
}

// Bulk actions are one atom run each (see `forEachIssue` for why N writes to
// the per-issue mutation atoms silently moved only one issue).
const transitionManyAtom = MapleApiAtomClient.runtime.fn<{
	readonly issueIds: ReadonlyArray<ErrorIssueId>
	readonly toState: WorkflowState
}>()(
	Effect.fnUntraced(function* ({ issueIds, toState }) {
		const client = yield* MapleApiAtomClient
		return yield* forEachIssue(issueIds, (issueId) =>
			client.errors.transitionIssue({
				params: { issueId },
				payload: new ErrorIssueTransitionRequest({ toState }),
			}),
		)
	}),
)

const claimManyAtom = MapleApiAtomClient.runtime.fn<{ readonly issueIds: ReadonlyArray<ErrorIssueId> }>()(
	Effect.fnUntraced(function* ({ issueIds }) {
		const client = yield* MapleApiAtomClient
		return yield* forEachIssue(issueIds, (issueId) =>
			client.errors.claimIssue({ params: { issueId }, payload: new ErrorIssueClaimRequest({}) }),
		)
	}),
)

const setSeverityManyAtom = MapleApiAtomClient.runtime.fn<{
	readonly issueIds: ReadonlyArray<ErrorIssueId>
	readonly severity: IssueSeverity | null
}>()(
	Effect.fnUntraced(function* ({ issueIds, severity }) {
		const client = yield* MapleApiAtomClient
		return yield* forEachIssue(issueIds, (issueId) =>
			client.errors.setIssueSeverity({
				params: { issueId },
				payload: new ErrorIssueSetSeverityRequest({ severity }),
			}),
		)
	}),
)

export function useIssueMutations(onSuccess?: () => void) {
	const transition = useAtomSet(MapleApiAtomClient.mutation("errors", "transitionIssue"), {
		mode: "promiseExit",
	})
	const claim = useAtomSet(MapleApiAtomClient.mutation("errors", "claimIssue"), { mode: "promiseExit" })
	const release = useAtomSet(MapleApiAtomClient.mutation("errors", "releaseIssue"), { mode: "promiseExit" })
	const severity = useAtomSet(MapleApiAtomClient.mutation("errors", "setIssueSeverity"), {
		mode: "promiseExit",
	})
	const transitionBatch = useAtomSet(transitionManyAtom, { mode: "promiseExit" })
	const claimBatch = useAtomSet(claimManyAtom, { mode: "promiseExit" })
	const severityBatch = useAtomSet(setSeverityManyAtom, { mode: "promiseExit" })

	const transitionTo = async (issueId: ErrorIssueId, toState: WorkflowState) => {
		const result = await transition({
			params: { issueId },
			payload: new ErrorIssueTransitionRequest({ toState }),
			reactivityKeys: [...INVALIDATE, issueKey(issueId)],
		})
		if (Exit.isSuccess(result)) {
			onSuccess?.()
			toastManager.add({ title: `Moved to ${WORKFLOW_LABEL[toState]}`, type: "success" })
		} else {
			logFailure("transitionTo", result)
			showErrorToast(result, { title: "State change failed" })
		}
		return result
	}

	const transitionMany = async (issueIds: ReadonlyArray<ErrorIssueId>, toState: WorkflowState) => {
		if (issueIds.length === 0) return
		const exit = await transitionBatch({ issueIds, toState })
		const outcome = batchOutcome(issueIds.length, exit, (failure) =>
			logFailure("transitionMany", failure),
		)
		if (outcome.failed === 0) {
			onSuccess?.()
			toastManager.add({
				title: `Moved ${issueIds.length} to ${WORKFLOW_LABEL[toState]}`,
				type: "success",
			})
		} else if (outcome.succeeded > 0) {
			onSuccess?.()
			showErrorToast(outcome.firstFailure, {
				title: `Moved ${outcome.succeeded} of ${issueIds.length}; ${outcome.failed} failed`,
				type: "warning",
			})
		} else {
			showErrorToast(outcome.firstFailure, { title: "State change failed" })
		}
	}

	const claimIssue = async (issueId: ErrorIssueId) => {
		const result = await claim({
			params: { issueId },
			payload: new ErrorIssueClaimRequest({}),
			reactivityKeys: [...INVALIDATE, issueKey(issueId)],
		})
		if (Exit.isSuccess(result)) {
			onSuccess?.()
			toastManager.add({ title: "Claimed", type: "success" })
		} else {
			logFailure("claim", result)
			showErrorToast(result, { title: "Claim failed" })
		}
		return result
	}

	const claimMany = async (issueIds: ReadonlyArray<ErrorIssueId>) => {
		if (issueIds.length === 0) return
		const exit = await claimBatch({ issueIds })
		const outcome = batchOutcome(issueIds.length, exit, (failure) => logFailure("claimMany", failure))
		if (outcome.failed === 0) {
			onSuccess?.()
			toastManager.add({ title: `Claimed ${issueIds.length} issues`, type: "success" })
		} else if (outcome.succeeded > 0) {
			onSuccess?.()
			showErrorToast(outcome.firstFailure, {
				title: `Claimed ${outcome.succeeded} of ${issueIds.length}; ${outcome.failed} failed`,
				type: "warning",
			})
		} else {
			showErrorToast(outcome.firstFailure, { title: "Claim failed" })
		}
	}

	const releaseIssue = async (issueId: ErrorIssueId) => {
		const result = await release({
			params: { issueId },
			payload: new ErrorIssueReleaseRequest({}),
			reactivityKeys: [...INVALIDATE, issueKey(issueId)],
		})
		if (Exit.isSuccess(result)) {
			onSuccess?.()
			toastManager.add({ title: "Released", type: "success" })
		} else {
			logFailure("release", result)
			showErrorToast(result, { title: "Release failed" })
		}
		return result
	}

	const setSeverity = async (issueId: ErrorIssueId, value: IssueSeverity | null) => {
		const result = await severity({
			params: { issueId },
			payload: new ErrorIssueSetSeverityRequest({ severity: value }),
			reactivityKeys: [...INVALIDATE, issueKey(issueId)],
		})
		if (Exit.isSuccess(result)) {
			onSuccess?.()
			toastManager.add({
				title: value === null ? "Severity cleared" : `Severity set to ${value}`,
				type: "success",
			})
		} else {
			logFailure("setSeverity", result)
			showErrorToast(result, { title: "Severity change failed" })
		}
		return result
	}

	const setSeverityMany = async (issueIds: ReadonlyArray<ErrorIssueId>, value: IssueSeverity | null) => {
		if (issueIds.length === 0) return
		const exit = await severityBatch({ issueIds, severity: value })
		const outcome = batchOutcome(issueIds.length, exit, (failure) =>
			logFailure("setSeverityMany", failure),
		)
		if (outcome.failed === 0) {
			onSuccess?.()
			toastManager.add({ title: `Updated severity for ${issueIds.length} issues`, type: "success" })
		} else if (outcome.succeeded > 0) {
			onSuccess?.()
			showErrorToast(outcome.firstFailure, {
				title: `Updated ${outcome.succeeded} of ${issueIds.length}; ${outcome.failed} failed`,
				type: "warning",
			})
		} else {
			showErrorToast(outcome.firstFailure, { title: "Severity change failed" })
		}
	}

	return {
		transitionTo,
		transitionMany,
		claimIssue,
		claimMany,
		releaseIssue,
		setSeverity,
		setSeverityMany,
	}
}

export type IssueMutations = ReturnType<typeof useIssueMutations>
