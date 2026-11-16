/**
 * What a pull request's security run audits: the paths its diff adds or changes. A large diff is
 * folded into its directories until it fits the run's scope limit; one that never fits is not
 * checked (null), rather than audited as the whole repository.
 */
import type { PullRequestFile } from "@maple/domain/http"
import { isSafeScopePath } from "@maple/security-audit/scope-path"
import { Array as Arr, String as Str } from "effect"

/** The most scope paths a run takes, as the audit API allows. */
export const PR_CHECK_MAX_SCOPE_PATHS = 100

const prefix = (path: string, depth: number) => Arr.join(Arr.take(Str.split("/")(path), depth), "/")

export const prScopePaths = (
	files: ReadonlyArray<PullRequestFile>,
	max = PR_CHECK_MAX_SCOPE_PATHS,
): ReadonlyArray<string> | null => {
	const paths = Arr.dedupe(
		Arr.filter(
			Arr.map(
				Arr.filter(files, (file) => file.status !== "removed"),
				(file) => file.path,
			),
			isSafeScopePath,
		),
	)
	const deepest = Math.max(0, ...Arr.map(paths, (path) => Str.split("/")(path).length))
	const fit = (depth: number): ReadonlyArray<string> | null => {
		if (depth < 1) return null
		const folded = Arr.dedupe(Arr.map(paths, (path) => prefix(path, depth)))
		return folded.length <= max ? folded : fit(depth - 1)
	}
	return paths.length <= max ? paths : fit(deepest - 1)
}
