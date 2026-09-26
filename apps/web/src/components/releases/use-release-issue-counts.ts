import { useMemo } from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { errorIssueFromV2 } from "@/lib/services/error-issues"
import { attributeIssues, type ReleaseIssueCounts, type ReleaseServiceImpact } from "./release-model"

/** One page of the v2 list; a window that introduced more says so rather than paging. */
const ISSUE_LIMIT = 100

export interface ReleaseIssueCountsState {
	/** Undefined while loading or when the list failed; the table then leaves the column blank. */
	counts: ReadonlyMap<string, ReleaseIssueCounts> | undefined
	/** True when more issues were introduced in the window than one page holds. */
	capped: boolean
}

/** Issues first seen or regressed inside the window, credited to the release that was live. */
export function useReleaseIssueCounts(
	impacts: ReadonlyArray<ReleaseServiceImpact>,
	windowStart: string,
): ReleaseIssueCountsState {
	const result = useAtomValue(
		retainedQueryV2("errorIssues", "list", {
			query: { introduced_after: new Date(Date.parse(windowStart)).toISOString(), limit: ISSUE_LIMIT },
			reactivityKeys: ["errorIssues"],
		}),
	)
	return useMemo(() => {
		if (!Result.isSuccess(result)) return { counts: undefined, capped: false }
		const issues = result.value.data.map(errorIssueFromV2)
		return { counts: attributeIssues(impacts, issues), capped: result.value.has_more }
	}, [result, impacts])
}
