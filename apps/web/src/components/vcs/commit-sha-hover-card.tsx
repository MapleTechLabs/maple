import { type ReactNode, useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"

import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { Result, useAtomValue } from "@/lib/effect-atom"
import type { VcsCommitDetailResponse } from "@maple/domain/http"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@maple/ui/components/ui/hover-card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { useClipboard } from "@maple/ui/hooks/use-clipboard"
import { cn } from "@maple/ui/utils"

// A full 40-hex git SHA. Telemetry `deployment.commit_sha` is unguarded OTel
// data, so a value may be a short SHA, a tag, or arbitrary text — those never
// open a hover card (and never hit the backend); they render as plain children.
const FULL_SHA = /^[0-9a-f]{40}$/i

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
}

/**
 * Wraps a rendered commit SHA in a rich hover card that lazily resolves the
 * commit's details from the (vendor-agnostic) VCS endpoint. Decoupled timing:
 * the fetch is armed after ~20ms of hover, while the card itself only becomes
 * visible after ~200ms — so the card almost always opens onto loaded data.
 */
export function CommitShaHoverCard({ sha, children, className, copy }: CommitShaHoverCardProps) {
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
				delay={OPEN_DELAY_MS}
				className={cn(handleCopy ? "cursor-pointer" : "cursor-default", className)}
				onMouseEnter={arm}
				onMouseLeave={cancelArm}
				onFocus={arm}
			>
				{children}
			</HoverCardTrigger>
			<HoverCardContent side="bottom" align="start" sideOffset={6} className="w-80 p-0">
				<CommitHoverBody sha={sha} />
			</HoverCardContent>
		</HoverCard>
	)
}

// Per-SHA query atom, memoized by args so the prefetch subscriber and the popup
// body share one in-flight request + cached result.
const commitQueryAtom = (sha: string) =>
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
					<CommitAvatar url={avatarUrl} name={author} />
					<div className="flex min-w-0 flex-col leading-tight">
						<span className="truncate font-medium text-foreground">{author}</span>
						{commit.repoFullName ? (
							<span className="truncate text-muted-foreground">{commit.repoFullName}</span>
						) : null}
					</div>
				</div>
				<div className="flex items-center justify-between gap-2 text-muted-foreground">
					<span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
						{commit.sha.slice(0, 7)}
					</span>
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

function CommitAvatar({ url, name }: { url: string | null; name: string }) {
	const [failed, setFailed] = useState(false)
	if (url && !failed) {
		return (
			<img
				src={url}
				alt=""
				className="size-7 shrink-0 rounded-full ring-1 ring-foreground/10"
				loading="lazy"
				referrerPolicy="no-referrer"
				onError={() => setFailed(true)}
			/>
		)
	}
	return (
		<div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium uppercase text-muted-foreground">
			{name.slice(0, 2)}
		</div>
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
