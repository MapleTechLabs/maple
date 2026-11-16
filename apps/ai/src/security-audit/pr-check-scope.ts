/**
 * What a pull request's security run audits: the paths its diff adds or changes. A path the audit
 * refuses as a scope (a reserved name, a `:`) is folded into its nearest directory it accepts, and a
 * large diff into its directories until it fits the run's scope limit. A changed file is never
 * dropped: when one cannot be scoped at all, the run audits the whole repository instead.
 */
import type { PullRequestFile } from "@maple/domain/http"
import { isSafeScopePath } from "@maple/security-audit/scope-path"
import { Array as Arr, String as Str } from "effect"

/** The most scope paths a run takes, as the audit API allows. */
export const PR_CHECK_MAX_SCOPE_PATHS = 100

export type PrScope =
	| { readonly kind: "paths"; readonly paths: Arr.NonEmptyReadonlyArray<string> }
	/** Audit everything: a changed path no scope can name, or a diff too spread out to fold. */
	| { readonly kind: "repository" }
	/** The pull request only removes files. */
	| { readonly kind: "empty" }

const segments = (path: string) => Str.split("/")(path)
const prefix = (path: string, depth: number) => Arr.join(Arr.take(segments(path), depth), "/")

/** The path itself when the audit accepts it, else its deepest accepted directory, else null. */
const scopable = (path: string): string | null => {
	const up = (depth: number): string | null =>
		depth < 1 ? null : isSafeScopePath(prefix(path, depth)) ? prefix(path, depth) : up(depth - 1)
	return isSafeScopePath(path) ? path : up(segments(path).length - 1)
}

export const prScope = (files: ReadonlyArray<PullRequestFile>, max = PR_CHECK_MAX_SCOPE_PATHS): PrScope => {
	const changed = Arr.map(
		Arr.filter(files, (file) => file.status !== "removed"),
		(file) => file.path,
	)
	if (!Arr.isReadonlyArrayNonEmpty(changed)) return { kind: "empty" }
	const scoped = Arr.map(changed, scopable)
	if (Arr.some(scoped, (path) => path === null)) return { kind: "repository" }
	const paths = Arr.dedupe(Arr.filter(scoped, (path): path is string => path !== null))
	const deepest = Math.max(0, ...Arr.map(paths, (path) => segments(path).length))
	const fit = (depth: number): ReadonlyArray<string> | null => {
		if (depth < 1) return null
		const folded = Arr.dedupe(Arr.map(paths, (path) => prefix(path, depth)))
		return folded.length <= max ? folded : fit(depth - 1)
	}
	const fitted = paths.length <= max ? paths : fit(deepest - 1)
	return fitted !== null && Arr.isReadonlyArrayNonEmpty(fitted)
		? { kind: "paths", paths: fitted }
		: { kind: "repository" }
}
