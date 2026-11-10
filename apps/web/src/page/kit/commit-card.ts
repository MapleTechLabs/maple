import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/views/ui/badge.styles"
import { copyableBadgeStyles } from "@maple/views/ui/copyable-badge.styles"
import { Duration, Effect, Predicate, type Result, Schema, String as Str, Option } from "effect"
import { AsyncData, Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { CallableTaggedStruct } from "foldkit/schema"
import * as HoverCard from "@maple/views/ui/hover-card"
import {
	IntegrationsNotConnectedError,
	VcsCommitDetailResponse,
	VcsCommitDetailsResponse,
} from "@maple/domain/http"
import { IdleTtl } from "../../data/idle-ttl"
import { ReadCache } from "../../data/read-cache"
import { orgOfKey, requestKey, type RequestKey } from "@maple/views/data/request-key"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { skeleton } from "@maple/views/ui/skeleton"
import { relativeTime } from "./relative-time"

// The commit SHA hover card: its state machine (arm, lookup, settle), the body
// `CommitDetailBody` renders once `commitQueryAtom(sha)` settles, and the lookup itself.

/** A full 40-hex git SHA: only those open a card and reach the VCS endpoint. */
export const isResolvableSha = (sha: string): boolean => /^[0-9a-f]{40}$/i.test(sha)

/** `firstLine`: a commit message's subject, trimmed. */
export const firstLine = (message: string): string =>
	Str.trim(
		Option.match(Str.indexOf("\n")(message), {
			onNone: () => message,
			onSome: (index) => Str.slice(0, index)(message),
		}),
	)

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

/** An org with no repository connected: every commit lookup answers the same 409. */
const notConnectedKey = (orgId: string): RequestKey => requestKey(orgId, "vcsNotConnected", {})
const NotConnected = Schema.Literal(true)
const isNotConnected = (error: unknown): boolean =>
	Str.endsWith("IntegrationsNotConnectedError")(errorTag(error))

/**
 * Once a lookup learns the org has no repository connected, later lookups answer from that memo for
 * its TTL (counted from the 409, not from each check) instead of sending another request. A refresh
 * always asks.
 */
const unlessNotConnected = <A, E, R>(key: RequestKey, lookup: Effect.Effect<A, E, R>, refresh = false) =>
	Effect.gen(function* () {
		const cache = yield* ReadCache
		const memoKey = notConnectedKey(orgOfKey(key))
		const memo = refresh ? Option.none() : yield* cache.peek(memoKey, NotConnected)
		if (Option.isSome(memo))
			return yield* new IntegrationsNotConnectedError({ message: "No repository is connected" })
		return yield* lookup.pipe(
			Effect.tapError((error) =>
				isNotConnected(error)
					? cache.read(
							{
								key: memoKey,
								idleTtlMs: IdleTtl.commitDetail,
								schema: NotConnected,
								refresh: true,
							},
							Effect.succeed(true as const),
						)
					: Effect.void,
			),
		)
	})

/** `integrations.vcsCommitDetail` through the read cache, under `commitDetailKey`. */
export const readCommitDetail = (key: RequestKey, sha: string) =>
	Effect.gen(function* () {
		const cache = yield* ReadCache
		const client = yield* MapleInternalApiClient
		return yield* unlessNotConnected(
			key,
			cache.read(
				{ key, idleTtlMs: IdleTtl.commitDetail, schema: VcsCommitDetailResponse },
				client.integrations.vcsCommitDetail({ params: { sha } }),
			),
		)
	})

/** `integrations.vcsCommitDetails` through the read cache, under `commitDetailsKey`. */
export const readCommitDetails = (key: RequestKey, shas: string, refresh = false) =>
	Effect.gen(function* () {
		const cache = yield* ReadCache
		const client = yield* MapleInternalApiClient
		return yield* unlessNotConnected(
			key,
			cache.read(
				{ key, idleTtlMs: IdleTtl.commitDetail, schema: VcsCommitDetailsResponse, refresh },
				client.integrations.vcsCommitDetails({ query: { shas } }),
			),
			refresh,
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

// STATE

/** One card per page, shared by every trigger, and the commits it looked up by sha. */
export const CommitCardState = Schema.Struct({
	commitCard: HoverCard.Model,
	commitDetails: Schema.Record(Schema.String, CommitDetailData.schema),
	/** A trigger enter's generation: the 20 ms arm only fires for the latest one. */
	commitArm: Schema.Number,
})
export type CommitCardState = typeof CommitCardState.Type

export const initCommitCard = (id: string): CommitCardState => ({
	commitCard: HoverCard.init(id, {
		openDelayMs: OPEN_DELAY_MS,
		side: "bottom",
		align: "start",
		sideOffset: 6,
	}),
	commitDetails: {},
	commitArm: 0,
})

const ArmFields = { sha: Schema.String, generation: Schema.Number }
const DetailFields = { sha: Schema.String, result: Schema.Result(CommitDetail, CommitFailure) }

/** The messages a page spreads into its union to run the card. */
export const CommitCardMessages = {
	GotCommitCardMessage: { message: HoverCard.Message },
	ElapsedCommitArm: ArmFields,
	CompletedFetchCommitDetail: DetailFields,
}

/** A page's arm timer (the lookup starts 20 ms into a hover, ahead of the card) and `commitQueryAtom(sha)`. */
export const commitCardCommands = <
	const ArmName extends string,
	const FetchName extends string,
	const ArmTag extends string,
	const DetailTag extends string,
>(
	names: Readonly<{ arm: ArmName; fetch: FetchName }>,
	messages: Readonly<{
		elapsed: CallableTaggedStruct<ArmTag, typeof ArmFields>
		completed: CallableTaggedStruct<DetailTag, typeof DetailFields>
	}>,
) => ({
	Arm: Command.define(names.arm, {
		args: ArmFields,
		messages: [messages.elapsed],
		execute: ({ sha, generation }) =>
			Effect.as(Effect.sleep(Duration.millis(ARM_DELAY_MS)), messages.elapsed({ sha, generation })),
	}),
	Fetch: Command.define(names.fetch, {
		args: { key: Schema.String, sha: Schema.String },
		messages: [messages.completed],
		execute: ({ key, sha }) =>
			Effect.map(loadCommitDetail(key, sha), (result) => messages.completed({ sha, result })),
	}),
})

/** A commit trigger's id ends in the sha it looks up. */
const shaOfTrigger = (triggerId: string): string => Str.slice(-40)(triggerId)

type Step<S, C> = Readonly<{ model: S; commands?: ReadonlyArray<C> }>

/** The card's own update, plus the 20 ms arm a trigger enter starts and a leave cancels. */
export const stepCommitCard = <S extends CommitCardState, M, C>(
	state: S,
	message: HoverCard.Message,
	options: Readonly<{
		toMessage: (message: HoverCard.Message) => M
		arm: (args: Readonly<{ sha: string; generation: number }>) => C
	}>,
): Step<S, Command.Command<M> | C> => {
	const next = HoverCard.update(state.commitCard, message)
	const lifted = Command.mapMessages(next.commands ?? [], options.toMessage)
	const arm = state.commitArm + 1
	if (message._tag === "EnteredTrigger") {
		const sha = shaOfTrigger(message.triggerId)
		const isArmed = state.commitDetails[sha] !== undefined
		return {
			model: { ...state, commitCard: next.model, commitArm: arm },
			commands: [...lifted, ...(isArmed ? [] : [options.arm({ sha, generation: arm })])],
		}
	}
	if (message._tag === "LeftTrigger")
		return { model: { ...state, commitCard: next.model, commitArm: arm }, commands: lifted }
	return { model: { ...state, commitCard: next.model }, commands: lifted }
}

/** Once armed it stays armed: the lookup survives the pointer leaving. */
export const elapsedCommitArm = <S extends CommitCardState, C>(
	state: S,
	args: Readonly<{ orgId: string; sha: string; generation: number }>,
	fetch: (args: Readonly<{ key: string; sha: string }>) => C,
): Step<S, C> =>
	args.generation !== state.commitArm || state.commitDetails[args.sha] !== undefined
		? { model: state }
		: {
				model: {
					...state,
					commitDetails: { ...state.commitDetails, [args.sha]: AsyncData.Loading() },
				},
				commands: [fetch({ key: commitDetailKey(args.orgId, args.sha), sha: args.sha })],
			}

export const settleCommitDetail = <S extends CommitCardState>(
	state: S,
	sha: string,
	result: Result.Result<CommitDetail, CommitFailure>,
): S => ({
	...state,
	commitDetails: {
		...state.commitDetails,
		[sha]: AsyncData.settle(state.commitDetails[sha] ?? AsyncData.Loading(), result),
	},
})

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
					h.Class(
						cn(
							"hover:text-foreground active:text-foreground hover:underline active:underline",
							className,
						),
					),
				],
				[text],
			)

/** `CommitAvatar`: the author's avatar, or their initials. TODO(avatar-error): a broken URL does not fall back to initials. */
export const commitAvatar = <M>(
	h: HtmlBuilder<M>,
	url: string | null,
	name: string,
	isCompact = true,
): Html => {
	const size = isCompact ? "size-5" : "size-7"
	return url === null
		? h.div(
				[
					h.Class(
						cn(
							size,
							"flex shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium uppercase text-muted-foreground",
						),
					),
				],
				[Str.slice(0, 2)(name)],
			)
		: h.img([
				h.Src(url),
				h.Alt(""),
				h.Class(cn(size, "shrink-0 rounded-full ring-1 ring-foreground/10")),
				h.Attribute("loading", "lazy"),
				h.Attribute("referrerpolicy", "no-referrer"),
			])
}

/** `CommitAvatar` (not compact), linked to the author's profile when known. */
const avatar = <M>(h: HtmlBuilder<M>, url: string | null, name: string, href: string | null): Html => {
	const inner = commitAvatar(h, url, name, false)
	return href === null
		? inner
		: h.a(
				[
					h.Href(href),
					h.Target("_blank"),
					h.Rel("noreferrer noopener"),
					h.AriaLabel(`${name}'s profile`),
					h.Class(
						"shrink-0 rounded-full outline-none transition-opacity hover:opacity-80 active:opacity-80 focus-visible:ring-2 focus-visible:ring-foreground/30",
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
	const newline = Str.indexOf("\n")(commit.message)
	const title = Option.match(newline, {
		onNone: () => commit.message,
		onSome: (index) => Str.slice(0, index)(commit.message),
	})
	const body = Option.match(newline, {
		onNone: () => "",
		onSome: (index) => Str.trim(Str.slice(index + 1)(commit.message)),
	})
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
					h.p(
						[h.Class(cn("font-medium leading-snug text-foreground", "line-clamp-2 text-sm"))],
						[title],
					),
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
						"flex items-center justify-center gap-1 font-medium text-primary hover:bg-surface-sunken active:bg-surface-sunken px-3.5 py-2.5",
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
	Str.endsWith("VcsCommitShaInvalidError")(tag)
		? { title: "Non-standard commit reference", detail: "Not a resolvable git SHA." }
		: Str.endsWith("VcsCommitNotFoundError")(tag)
			? {
					title: "Commit not found",
					detail: "Maple has no record of this commit. Make sure its repository is connected and Maple still has access to it.",
					action: "manage",
				}
			: Str.endsWith("IntegrationsNotConnectedError")(tag)
				? {
						title: "No repository connected",
						detail: "Connect a repository so Maple can resolve commits to their author, message, and repo.",
						action: "connect",
					}
				: { title: "Couldn't load commit", detail: "Try again in a moment." }

const ACTION_CLASS =
	"mt-0.5 inline-flex w-fit items-center gap-1 font-medium text-primary hover:underline active:underline"

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
