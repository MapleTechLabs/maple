import type { VcsCommitDetailResponse, VcsCommitRangeResponse } from "@maple/domain/http"
import {
	attributeIssues,
	countIssues,
	deriveReleaseImpacts,
	groupReleases,
	liveVersions,
	previousSha,
	releaseFacetCounts,
	type ReleaseGroup,
	type ReleaseIssueCounts,
	type ReleaseServiceImpact,
} from "../../../components/releases/release-model"
import { errorIssueFromV2 } from "../../../lib/services/error-issues"
import { AsyncData } from "foldkit"
import type { ReleasesSearch } from "../../../route/search"
import { commitRangesKey, commitsQueryKey } from "../kit"
import type { IssuePage, Model, ReleasesData } from "./model"

export type Search = typeof ReleasesSearch.Type

export const DEFAULT_PRESET = "7d"
/** The bulk VCS lookup takes one page of shas; rows past it fall back to the sha. */
export const COMMIT_RESOLVE_LIMIT = 50

export interface Derived {
	readonly impacts: ReadonlyArray<ReleaseServiceImpact>
	readonly groups: ReadonlyArray<ReleaseGroup>
	readonly live: ReturnType<typeof liveVersions>
	readonly response: ReleasesData
}

/** The page's `derived` memo: impacts, groups and live versions of the loaded rows. */
export const deriveOf = (data: ReleasesData): Derived => {
	const releases = data.releases.map((row) => ({ ...row }))
	const timeline = data.timeline.map((row) => ({ ...row }))
	const impacts = deriveReleaseImpacts(releases, timeline)
	const groups = groupReleases(impacts)
	return { impacts, groups, live: liveVersions(timeline, groups), response: data }
}

export const facetsOf = (data: ReleasesData) => releaseFacetCounts(deriveOf(data).groups)

export const hasFilters = (search: Search): boolean =>
	(search.environments?.length ?? 0) > 0 ||
	(search.excludedEnvironments?.length ?? 0) > 0 ||
	(search.services?.length ?? 0) > 0 ||
	search.impact !== undefined

/** The groups the table resolves commits for. */
const resolvedGroups = (groups: ReadonlyArray<ReleaseGroup>) => groups.slice(0, COMMIT_RESOLVE_LIMIT)

export const shasKeyOf = (groups: ReadonlyArray<ReleaseGroup>): string =>
	commitsQueryKey(resolvedGroups(groups).map((group) => group.commitSha))

export const rangesKeyOf = (groups: ReadonlyArray<ReleaseGroup>): string =>
	commitRangesKey(
		resolvedGroups(groups).flatMap((group) => {
			const base = previousSha(group)
			return base === undefined ? [] : [{ base, head: group.commitSha }]
		}),
	)

export const commitsOf = (model: Model): ReadonlyMap<string, VcsCommitDetailResponse> =>
	new Map(AsyncData.getOrElse(model.commits.data, () => []).map((commit) => [commit.sha, commit]))

export const rangesOf = (model: Model): ReadonlyMap<string, VcsCommitRangeResponse> =>
	new Map(
		AsyncData.getOrElse(model.ranges.data, () => [])
			.filter((range) => range.status === "resolved")
			.map((range) => [range.head, range]),
	)

/** `useReleaseIssueCounts`: undefined while loading or failed. */
export const issueCountsOf = (
	impacts: ReadonlyArray<ReleaseServiceImpact>,
	page: IssuePage | null,
): ReadonlyMap<string, ReleaseIssueCounts> | undefined =>
	page === null ? undefined : countIssues(attributeIssues(impacts, page.data.map(errorIssueFromV2)))
