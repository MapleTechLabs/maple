import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { copyableBadgeStyles } from "@maple/ui/styles/ui/copyable-badge"
import { Effect, Predicate, Schema } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { VcsCommitDetailResponse, VcsCommitDetailsResponse } from "@maple/domain/http"
import { IdleTtl } from "../../data/idle-ttl"
import { ReadCache } from "../../data/read-cache"
import { requestKey, type RequestKey } from "../../data/request-key"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { skeleton } from "../../ui/skeleton"
import { relativeTime } from "./relative-time"

// The commit SHA hover card: the body
// `CommitDetailBody` renders once `commitQueryAtom(sha)` settles, and the lookup itself.

/** A full 40-hex git SHA: only those open a card and reach the VCS endpoint. */
export const isResolvableSha = (sha: string): boolean => /^[0-9a-f]{40}$/i.test(sha)

/** `CommitShaHoverCard`'s timings: the fetch arms after 20 ms, the card opens after 200 ms. */
export const ARM_DELAY_MS = 20
export const OPEN_DELAY_MS = 200

export const CommitDetail = Schema.Struct({
	provider: Schema.String,
	sha: Schema.String,
	message: Schema.String,
	authorName: Schema.NullOr(Schema.String),
	authorLogin: Schema.NullOr(Schema.String),
	authorAvatarUrl: Schema.NullOr(Schema.String),
	committedAt: Schema.Number,
	htmlUrl: Schema.String,
	repoFullName: Schema.String,
})
export type CommitDetail = typeof CommitDetail.Type

/** A failed lookup keeps its error tag (`describeError`). */
export const CommitFailure = Schema.Struct({ tag: Schema.String })
export type CommitFailure = typeof CommitFailure.Type
export const CommitDetailData = AsyncData.Schema(CommitDetail, CommitFailure)
export type CommitDetailData = AsyncData.AsyncData<CommitDetail, CommitFailure>

const errorTag = (error: unknown): string =>
	Predicate.hasProperty(error, "_tag") && typeof error._tag === "string" ? error._tag : ""

/** `commitQueryAtom(sha)`'s identity: every page reading one commit shares its read. */
export const commitDetailKey = (orgId: string, sha: string): RequestKey =>
	requestKey(orgId, "vcsCommitDetail", { sha })

/** `commitsQueryAtom(shasKey)`'s identity (`commitsQueryKey`: deduped, sorted, comma-joined). */
export const commitDetailsKey = (orgId: string, shasKey: string): RequestKey =>
	requestKey(orgId, "vcsCommitDetails", { shas: shasKey })

/** `integrations.vcsCommitDetail` through the read cache, under `commitDetailKey`. */
export const readCommitDetail = (key: RequestKey, sha: string) =>
	Effect.gen(function* () {
		const cache = yield* ReadCache
		const client = yield* MapleInternalApiClient
		return yield* cache.read(
			{ key, idleTtlMs: IdleTtl.commitDetail, schema: VcsCommitDetailResponse },
			client.integrations.vcsCommitDetail({ params: { sha } }),
		)
	})

/** `integrations.vcsCommitDetails` through the read cache, under `commitDetailsKey`. */
export const readCommitDetails = (key: RequestKey, shas: string, refresh = false) =>
	Effect.gen(function* () {
		const cache = yield* ReadCache
		const client = yield* MapleInternalApiClient
		return yield* cache.read(
			{ key, idleTtlMs: IdleTtl.commitDetail, schema: VcsCommitDetailsResponse, refresh },
			client.integrations.vcsCommitDetails({ query: { shas } }),
		)
	})

/** `commitQueryAtom(sha)` as the hover card reads it. */
export const loadCommitDetail = (key: RequestKey, sha: string) =>
	Effect.gen(function* () {
		const commit = yield* readCommitDetail(key, sha)
		return {
			provider: commit.provider,
			sha: commit.sha,
			message: commit.message,
			authorName: commit.authorName,
			authorLogin: commit.authorLogin,
			authorAvatarUrl: commit.authorAvatarUrl,
			committedAt: commit.committedAt,
			htmlUrl: commit.htmlUrl,
			repoFullName: commit.repoFullName,
		}
	}).pipe(
		Effect.mapError((error): CommitFailure => ({ tag: errorTag(error) })),
		Effect.result,
	)

// VIEW

type Clock = Readonly<{ nowMs: number; timeZone: string }>

/** `hrefFromOrigin`: an author or repo path on the commit URL's host. */
const hrefFromOrigin = (baseUrl: string, path: string): string | null =>
	URL.canParse(`/${path}`, baseUrl) ? new URL(`/${path}`, baseUrl).href : null

const externalText = <M>(h: HtmlBuilder<M>, href: string | null, className: string, text: string): Html =>
	href === null
		? h.span([h.Class(className)], [text])
		: h.a(
				[
					h.Href(href),
					h.Target("_blank"),
					h.Rel("noreferrer noopener"),
					h.Class(cn("transition-colors hover:text-foreground hover:underline", className)),
				],
				[text],
			)

/** `CommitAvatar` (not compact). */
const avatar = <M>(h: HtmlBuilder<M>, url: string | null, name: string, href: string | null): Html => {
	const inner =
		url === null
			? h.div(
					[
						h.Class(
							"size-7 flex shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium uppercase text-muted-foreground",
						),
					],
					[name.slice(0, 2)],
				)
			: h.img([
					h.Src(url),
					h.Alt(""),
					h.Class("size-7 shrink-0 rounded-full ring-1 ring-foreground/10"),
					h.Attribute("loading", "lazy"),
					h.Attribute("referrerpolicy", "no-referrer"),
				])
	return href === null
		? inner
		: h.a(
				[
					h.Href(href),
					h.Target("_blank"),
					h.Rel("noreferrer noopener"),
					h.AriaLabel(`${name}'s profile`),
					h.Class(
						"shrink-0 rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-foreground/30",
					),
				],
				[inner],
			)
}

/** `CommitCard` (not compact): subject and body, author and repo, sha and age, the provider link. */
const commitCard = <M>(
	h: HtmlBuilder<M>,
	commit: CommitDetail,
	clock: Clock,
	onCopy: M | undefined,
): Html => {
	const newline = commit.message.indexOf("\n")
	const title = newline === -1 ? commit.message : commit.message.slice(0, newline)
	const body = newline === -1 ? "" : commit.message.slice(newline + 1).trim()
	const providerLabel = commit.provider === "github" ? "GitHub" : commit.provider
	const author = commit.authorLogin ?? commit.authorName ?? "Unknown author"
	const profileHref =
		commit.authorLogin === null ? null : hrefFromOrigin(commit.htmlUrl, commit.authorLogin)
	const repoHref = commit.repoFullName === "" ? null : hrefFromOrigin(commit.htmlUrl, commit.repoFullName)
	const repo =
		commit.repoFullName === ""
			? []
			: [externalText(h, repoHref, "truncate text-muted-foreground", commit.repoFullName)]
	return h.div(
		[h.Class("flex flex-col divide-y divide-foreground/10")],
		[
			h.div(
				[h.Class("flex flex-col gap-1.5 p-3.5")],
				[
					h.p([h.Class(cn("font-medium leading-snug text-foreground", "line-clamp-2 text-sm"))], [title]),
					...(body === ""
						? []
						: [h.p([h.Class("line-clamp-4 whitespace-pre-line text-muted-foreground")], [body])]),
				],
			),
			h.div(
				[h.Class("flex flex-col gap-2.5 p-3.5")],
				[
					h.div(
						[h.Class("flex items-center gap-2.5")],
						[
							avatar(h, commit.authorAvatarUrl, author, profileHref),
							h.div(
								[h.Class("flex min-w-0 flex-col leading-tight")],
								[
									externalText(
										h,
										profileHref,
										"truncate font-medium text-foreground",
										author,
									),
									...repo,
								],
							),
						],
					),
					h.div(
						[h.Class("flex items-center justify-between gap-2 text-muted-foreground")],
						[
							copyableSha(h, commit.sha, onCopy),
							relativeTime(h, {
								value: commit.committedAt,
								...clock,
								tooltip: "title",
								className: "cursor-default",
							}),
						],
					),
				],
			),
			h.a(
				[
					h.Href(commit.htmlUrl),
					h.Target("_blank"),
					h.Rel("noreferrer noopener"),
					h.Class(
						"flex items-center justify-center gap-1 font-medium text-primary transition-colors hover:bg-surface-sunken px-3.5 py-2.5",
					),
				],
				["View on ", providerLabel, h.span([h.AriaHidden(true)], ["↗"])],
			),
		],
	)
}

/** `CopyableSha`: the short sha as a copy badge (copies the full sha). */
const copyableSha = <M>(h: HtmlBuilder<M>, sha: string, onCopy: M | undefined): Html =>
	h.button(
		[
			h.Type("button"),
			h.AriaLabel("Copy commit SHA"),
			h.Class(cn(badgeVariants({ variant: "muted", size: "sm" }), copyableBadgeStyles, "font-mono")),
			h.DataAttribute("base-ui-tooltip-trigger", ""),
			h.DataAttribute("slot", "tooltip-trigger"),
			...(onCopy === undefined ? [] : [h.OnClick(onCopy)]),
		],
		[shortId(sha, "sha")],
	)

/** `CommitSkeleton` (not compact). */
const commitSkeleton = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("flex flex-col gap-3 p-3.5")],
		[
			skeleton(h, "h-4 w-11/12"),
			h.div(
				[h.Class("flex items-center gap-2.5")],
				[
					skeleton(h, "shrink-0 rounded-full size-7"),
					h.div(
						[h.Class("flex flex-1 flex-col gap-1.5")],
						[skeleton(h, "h-3 w-1/2"), skeleton(h, "h-3 w-2/3")],
					),
				],
			),
			skeleton(h, "h-3 w-full"),
		],
	)

/** `describeError`: a graceful message, with a link into integrations where it helps. */
const describeError = (
	tag: string,
): Readonly<{ title: string; detail: string; action?: "connect" | "manage" }> =>
	tag.endsWith("VcsCommitShaInvalidError")
		? { title: "Non-standard commit reference", detail: "Not a resolvable git SHA." }
		: tag.endsWith("VcsCommitNotFoundError")
			? {
					title: "Commit not found",
					detail: "Maple has no record of this commit. Make sure its repository is connected and Maple still has access to it.",
					action: "manage",
				}
			: tag.endsWith("IntegrationsNotConnectedError")
				? {
						title: "No repository connected",
						detail: "Connect a repository so Maple can resolve commits to their author, message, and repo.",
						action: "connect",
					}
				: { title: "Couldn't load commit", detail: "Try again in a moment." }

const ACTION_CLASS = "mt-0.5 inline-flex w-fit items-center gap-1 font-medium text-primary hover:underline"

/** `CommitMessage` (not compact). */
const commitMessage = <M>(h: HtmlBuilder<M>, tag: string): Html => {
	const { title, detail, action } = describeError(tag)
	const link = (href: string, label: string) =>
		h.a([h.Href(href), h.Class(ACTION_CLASS)], [label, h.span([h.AriaHidden(true)], ["→"])])
	return h.div(
		[h.Class("flex flex-col gap-1.5 p-3.5")],
		[
			h.p([h.Class("font-medium text-foreground")], [title]),
			h.p([h.Class("text-muted-foreground")], [detail]),
			...(action === "connect"
				? [link("/sources/new?integration=github", "Connect a repository")]
				: action === "manage"
					? [link("/sources/new?integration=github", "Manage repository access")]
					: []),
		],
	)
}

/** `CommitHoverBody`: the card, its error message, or the skeleton while the lookup runs. */
export const commitDetailBody = <M>(
	h: HtmlBuilder<M>,
	data: CommitDetailData,
	clock: Clock,
	onCopy?: (sha: string) => M,
): Html =>
	AsyncData.match(data, {
		onIdle: () => commitSkeleton(h),
		onLoading: () => commitSkeleton(h),
		onFailure: (failure) => commitMessage(h, failure.tag),
		onStale: ({ error }) => commitMessage(h, error.tag),
		onRefreshing: (commit) => commitCard(h, commit, clock, onCopy?.(commit.sha)),
		onSuccess: (commit) => commitCard(h, commit, clock, onCopy?.(commit.sha)),
	})
