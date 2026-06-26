import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"

import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { CheckIcon, CopyIcon } from "@/components/icons"
import type { VcsCommitDetailResponse } from "@maple/domain/http"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@maple/ui/components/ui/hover-card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { useClipboard } from "@maple/ui/hooks/use-clipboard"
import { cn } from "@maple/ui/utils"

// A full 40-hex git SHA. Telemetry `deployment.commit_sha` is unguarded OTel
// data, so a value may be a short SHA, a tag, or arbitrary text — those never
// open a hover card (and never hit the backend); they render as plain children.
const FULL_SHA = /^[0-9a-f]{40}$/i

/** Whether `sha` is a full 40-hex git SHA that the VCS endpoint can resolve. */
export function isResolvableSha(sha: string): boolean {
	return FULL_SHA.test(sha)
}

// Card becomes visible after this long a hover; fetch is armed sooner (ARM_DELAY_MS)
// so the request is already in flight (or cached) when the card opens.
const OPEN_DELAY_MS = 200
const ARM_DELAY_MS = 20

interface CommitShaHoverCardProps {
	/** The full commit SHA. If not a 40-hex SHA, children render without a card. */
	sha: string
	/** The trigger content (typically the truncated, styled SHA). */
	children: ReactNode
	/** Applied to the trigger element. */
	className?: string
	/**
	 * When set, the trigger is a button that copies this value on click (with a
	 * toast). Keeps copy affordance and hover card in one element so they never
	 * stack as separate popups.
	 */
	copy?: { value: string; label: string }
	/**
	 * How long (ms) the trigger must be hovered before the card opens. Defaults to
	 * a snappy 200ms. Deploy markers pass a much longer delay (~1.5s): their hitbox
	 * spans the whole reference line, so a cursor merely crossing the chart
	 * shouldn't trip the card open.
	 */
	openDelay?: number
	/** Side the popup opens on, relative to its anchor (default "bottom"). */
	side?: "top" | "right" | "bottom" | "left"
	/** Cross-axis alignment of the popup (default "start"). */
	align?: "start" | "center" | "end"
	/** Popup distance from its anchor in px (default 6). */
	sideOffset?: number
	/**
	 * Anchor the popup to a specific element rather than the trigger. Deploy markers
	 * use this to pin the card to the flag at the top of the line while the hover
	 * hitbox spans the line's full height.
	 */
	anchor?: RefObject<HTMLElement | null>
}

/**
 * Wraps a rendered commit SHA in a rich hover card that lazily resolves the
 * commit's details from the (vendor-agnostic) VCS endpoint. Decoupled timing:
 * the fetch is armed after ~20ms of hover, while the card itself only becomes
 * visible after ~200ms — so the card almost always opens onto loaded data.
 */
export function CommitShaHoverCard({
	sha,
	children,
	className,
	copy,
	openDelay = OPEN_DELAY_MS,
	side = "bottom",
	align = "start",
	sideOffset = 6,
	anchor,
}: CommitShaHoverCardProps) {
	const isFullSha = FULL_SHA.test(sha)
	const clipboard = useClipboard()
	// Once armed we keep it armed: the in-flight/cached result should survive the
	// cursor leaving, so a re-hover is instant.
	const [armed, setArmed] = useState(false)
	const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(
		() => () => {
			if (armTimer.current) clearTimeout(armTimer.current)
		},
		[],
	)

	const handleCopy = copy
		? async () => {
				try {
					await clipboard.copy(copy.value)
					toast.success(`${copy.label} copied to clipboard`)
				} catch {
					toast.error(`Failed to copy ${copy.label}`)
				}
			}
		: undefined

	// Non-resolvable SHA (short/tag/arbitrary telemetry): no card, no fetch. Still
	// copyable where a copy affordance was requested.
	if (!isFullSha) {
		return handleCopy ? (
			<button type="button" onClick={handleCopy} className={cn("cursor-pointer", className)}>
				{children}
			</button>
		) : (
			<span className={className}>{children}</span>
		)
	}

	const arm = () => {
		if (armed || armTimer.current) return
		armTimer.current = setTimeout(() => {
			armTimer.current = null
			setArmed(true)
		}, ARM_DELAY_MS)
	}

	const cancelArm = () => {
		if (armTimer.current) {
			clearTimeout(armTimer.current)
			armTimer.current = null
		}
	}

	return (
		<HoverCard>
			{/* The popup content (and its query) only mounts when the card opens at
			    ~200ms; this sibling mounts as soon as armed (~20ms) and subscribes to
			    the SAME memoized atom, so the fetch is already in flight by open. */}
			{armed ? <CommitPrefetch sha={sha} /> : null}
			<HoverCardTrigger
				render={handleCopy ? <button type="button" onClick={handleCopy} /> : <span />}
				delay={openDelay}
				className={cn(handleCopy ? "cursor-pointer" : "cursor-default", className)}
				onMouseEnter={arm}
				onMouseLeave={cancelArm}
				onFocus={arm}
			>
				{children}
			</HoverCardTrigger>
			<HoverCardContent
				side={side}
				align={align}
				sideOffset={sideOffset}
				anchor={anchor}
				className="w-80 p-0"
			>
				<CommitHoverBody sha={sha} />
			</HoverCardContent>
		</HoverCard>
	)
}

// Per-SHA query atom, memoized by args so the prefetch subscriber, the popup body,
// and the deploy-marker flag all share one in-flight request + cached result.
export const commitQueryAtom = (sha: string) =>
	MapleApiAtomClient.query("integrations", "vcsCommitDetail", { params: { sha } })

// Renders nothing — it exists only to mount (and thus run) the query early.
function CommitPrefetch({ sha }: { sha: string }) {
	useAtomValue(commitQueryAtom(sha))
	return null
}

function CommitHoverBody({ sha }: { sha: string }) {
	// By the time the popup opens (open delay > arm delay) the prefetch has already
	// armed the same atom; reading it here is a cache hit or a near-complete fetch.
	const result = useAtomValue(commitQueryAtom(sha))

	return Result.builder(result)
		.onSuccess((commit) => <CommitCard commit={commit} />)
		.onError((error) => <CommitMessage {...describeError(error)} />)
		.orElse(() => <CommitSkeleton />)
}

function CommitCard({ commit }: { commit: VcsCommitDetailResponse }) {
	// A git message is a subject line, then an optional body after a blank line.
	const newlineIdx = commit.message.indexOf("\n")
	const title = newlineIdx === -1 ? commit.message : commit.message.slice(0, newlineIdx)
	const body = newlineIdx === -1 ? "" : commit.message.slice(newlineIdx + 1).trim()
	const providerLabel = commit.provider === "github" ? "GitHub" : commit.provider
	const author = commit.authorLogin ?? commit.authorName ?? "Unknown author"
	// Push-webhook payloads carry no avatar URL (only a username), so commits
	// ingested that way have a null avatar. GitHub serves a stable avatar for any
	// login at github.com/<login>.png — derive it as a fallback so those still show.
	const avatarUrl =
		commit.authorAvatarUrl ??
		(commit.provider === "github" && commit.authorLogin
			? `https://github.com/${encodeURIComponent(commit.authorLogin)}.png?size=64`
			: null)
	// Profile and repo links are derived from the commit's own htmlUrl origin, so
	// they stay correct across providers and self-hosted instances (github.com, GH
	// Enterprise, GitLab, …) without hardcoding a host.
	const profileHref = commit.authorLogin ? hrefFromOrigin(commit.htmlUrl, commit.authorLogin) : null
	const repoHref = commit.repoFullName ? hrefFromOrigin(commit.htmlUrl, commit.repoFullName) : null

	return (
		<div className="flex flex-col divide-y divide-foreground/10">
			<div className="flex flex-col gap-1.5 p-3.5">
				<p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">{title}</p>
				{body ? (
					<p className="line-clamp-4 whitespace-pre-line text-muted-foreground">{body}</p>
				) : null}
			</div>
			<div className="flex flex-col gap-2.5 p-3.5">
				<div className="flex items-center gap-2.5">
					<CommitAvatar url={avatarUrl} name={author} href={profileHref} />
					<div className="flex min-w-0 flex-col leading-tight">
						<ExternalText href={profileHref} className="truncate font-medium text-foreground">
							{author}
						</ExternalText>
						{commit.repoFullName ? (
							<ExternalText href={repoHref} className="truncate text-muted-foreground">
								{commit.repoFullName}
							</ExternalText>
						) : null}
					</div>
				</div>
				<div className="flex items-center justify-between gap-2 text-muted-foreground">
					<CopyableSha sha={commit.sha} />
					<span>{formatRelative(commit.committedAt)}</span>
				</div>
			</div>
			<a
				href={commit.htmlUrl}
				target="_blank"
				rel="noreferrer noopener"
				className="flex items-center justify-center gap-1 px-3.5 py-2.5 font-medium text-primary transition-colors hover:bg-muted/60"
			>
				View on {providerLabel}
				<span aria-hidden>↗</span>
			</a>
		</div>
	)
}

// Builds an absolute URL from the origin of a known-good commit URL plus a path
// (an author login, or `owner/repo`). Origin-relative so the path's own slashes
// are preserved. Returns null if the base URL can't be parsed.
function hrefFromOrigin(baseUrl: string, path: string): string | null {
	try {
		return new URL(`/${path}`, baseUrl).href
	} catch {
		return null
	}
}

// Text that links out (new tab) when an href is available, else plain text. Used
// for the author and repo lines so both become clickable when resolvable.
function ExternalText({
	href,
	className,
	children,
}: {
	href: string | null
	className?: string
	children: ReactNode
}) {
	if (!href) {
		return <span className={className}>{children}</span>
	}
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			className={cn("transition-colors hover:text-foreground hover:underline", className)}
		>
			{children}
		</a>
	)
}

// The short SHA, rendered as a copy button (copies the full SHA). Replaces the
// bare badge so the value is actually useful instead of just decorative.
function CopyableSha({ sha }: { sha: string }) {
	const clipboard = useClipboard()
	const [copied, setCopied] = useState(false)
	const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(
		() => () => {
			if (resetTimer.current) clearTimeout(resetTimer.current)
		},
		[],
	)

	const handleCopy = async () => {
		try {
			await clipboard.copy(sha)
			setCopied(true)
			if (resetTimer.current) clearTimeout(resetTimer.current)
			resetTimer.current = setTimeout(() => setCopied(false), 1200)
		} catch {
			toast.error("Failed to copy commit SHA")
		}
	}

	return (
		<button
			type="button"
			onClick={handleCopy}
			aria-label="Copy commit SHA"
			className="group inline-flex items-center gap-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80 transition-colors hover:bg-muted/70"
		>
			{sha.slice(0, 7)}
			{copied ? (
				<CheckIcon size={11} className="text-success" />
			) : (
				<CopyIcon
					size={11}
					className="text-muted-foreground transition-colors group-hover:text-foreground/80"
				/>
			)}
		</button>
	)
}

function CommitAvatar({
	url,
	name,
	href,
}: {
	url: string | null
	name: string
	href?: string | null
}) {
	const [failed, setFailed] = useState(false)
	const inner =
		url && !failed ? (
			<img
				src={url}
				alt=""
				className="size-7 shrink-0 rounded-full ring-1 ring-foreground/10"
				loading="lazy"
				referrerPolicy="no-referrer"
				onError={() => setFailed(true)}
			/>
		) : (
			<div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium uppercase text-muted-foreground">
				{name.slice(0, 2)}
			</div>
		)

	if (!href) return inner
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			aria-label={`${name}'s profile`}
			className="shrink-0 rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-foreground/30"
		>
			{inner}
		</a>
	)
}

function CommitSkeleton() {
	return (
		<div className="flex flex-col gap-3 p-3.5">
			<Skeleton className="h-4 w-11/12" />
			<div className="flex items-center gap-2.5">
				<Skeleton className="size-7 shrink-0 rounded-full" />
				<div className="flex flex-1 flex-col gap-1.5">
					<Skeleton className="h-3 w-1/2" />
					<Skeleton className="h-3 w-2/3" />
				</div>
			</div>
			<Skeleton className="h-3 w-full" />
		</div>
	)
}

// An optional call-to-action shown beneath an error message, linking into the
// integrations area: "connect" → the catalog (no provider yet), "manage" → the
// GitHub card (a provider is connected but this commit's repo may not be shared).
type CommitMessageAction = "connect" | "manage"

function CommitMessage({
	title,
	detail,
	action,
}: {
	title: string
	detail?: string
	action?: CommitMessageAction
}) {
	return (
		<div className="flex flex-col gap-1.5 p-3.5">
			<p className="font-medium text-foreground">{title}</p>
			{detail ? <p className="text-muted-foreground">{detail}</p> : null}
			{action === "connect" ? (
				<Link
					to="/integrations"
					className="mt-0.5 inline-flex w-fit items-center gap-1 font-medium text-primary hover:underline"
				>
					Connect a repository
					<span aria-hidden>→</span>
				</Link>
			) : action === "manage" ? (
				<Link
					to="/integrations"
					search={{ integration: "github" }}
					className="mt-0.5 inline-flex w-fit items-center gap-1 font-medium text-primary hover:underline"
				>
					Manage repository access
					<span aria-hidden>→</span>
				</Link>
			) : null}
		</div>
	)
}

// Map a resolved error to a graceful, non-alarming message. The invalid-SHA case
// is guarded client-side too (FULL_SHA), but a server-side
// VcsCommitShaInvalidError is handled here as defense-in-depth.
function describeError(error: unknown): {
	title: string
	detail?: string
	action?: CommitMessageAction
} {
	const tag =
		typeof error === "object" && error !== null && "_tag" in error
			? String((error as { _tag: unknown })._tag)
			: ""
	if (tag.endsWith("VcsCommitShaInvalidError")) {
		return { title: "Non-standard commit reference", detail: "Not a resolvable git SHA." }
	}
	if (tag.endsWith("VcsCommitNotFoundError")) {
		// Not "please wait" — a backfilled repo would already have this commit. The
		// likely cause is that the commit's repository isn't connected (or its access
		// was revoked), so point the user at fixing repository access.
		return {
			title: "Commit not found",
			detail: "Maple has no record of this commit. Make sure its repository is connected and Maple still has access to it.",
			action: "manage",
		}
	}
	if (tag.endsWith("IntegrationsNotConnectedError")) {
		return {
			title: "No repository connected",
			detail: "Connect a repository so Maple can resolve commits to their author, message, and repo.",
			action: "connect",
		}
	}
	return { title: "Couldn't load commit", detail: "Try again in a moment." }
}

function formatRelative(epochMs: number): string {
	const diff = Date.now() - epochMs
	if (diff < 0) return "just now"
	const seconds = Math.floor(diff / 1000)
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	if (days < 30) return `${days}d ago`
	const months = Math.floor(days / 30)
	if (months < 12) return `${months}mo ago`
	return `${Math.floor(days / 365)}y ago`
}
