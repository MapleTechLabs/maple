import { useCallback } from "react"
import { Exit } from "effect"
import { CommitsLookupRequest, CommitsResyncRequest, type CommitInfo } from "@maple/domain/http"
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@maple/ui/components/ui/avatar"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@maple/ui/components/ui/hover-card"
import { cn } from "@maple/ui/lib/utils"
import { GitCommitIcon } from "@/components/icons"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { useCommitLookup } from "./commit-lookup-context"

const SHA_REGEX = /^[0-9a-f]{7,40}$/i
const RESYNC_ATTEMPTED = new Set<string>()

interface CommitChipProps {
	readonly sha: string
	readonly className?: string
	readonly showIcon?: boolean
}

export function CommitChip({ sha, className, showIcon = false }: CommitChipProps) {
	const ctx = useCommitLookup()
	const isValidSha = SHA_REGEX.test(sha)
	const fromContext = isValidSha && ctx.lookup.has(sha) ? ctx.lookup.get(sha) ?? null : undefined

	if (!isValidSha || sha === "N/A" || sha === "unknown") {
		return (
			<span className={cn("font-mono text-muted-foreground", className)}>
				{sha || "N/A"}
			</span>
		)
	}

	if (fromContext !== undefined) {
		return (
			<CommitChipBody
				sha={sha}
				commit={fromContext}
				loading={ctx.loading}
				className={className}
				showIcon={showIcon}
			/>
		)
	}

	return <CommitChipFallback sha={sha} className={className} showIcon={showIcon} />
}

function CommitChipFallback({
	sha,
	className,
	showIcon,
}: {
	readonly sha: string
	readonly className?: string
	readonly showIcon: boolean
}) {
	const result = useAtomValue(
		MapleApiAtomClient.query("commits", "commitsLookupBySha", {
			payload: new CommitsLookupRequest({ shas: [sha] }),
			reactivityKeys: ["commitLookup", sha],
		}),
	)
	const commit = Result.builder(result)
		.onSuccess((res) => res.entries[0]?.commit ?? null)
		.orElse(() => null)
	return (
		<CommitChipBody
			sha={sha}
			commit={commit}
			loading={Result.isInitial(result)}
			className={className}
			showIcon={showIcon}
		/>
	)
}

function CommitChipBody({
	sha,
	commit,
	loading,
	className,
	showIcon,
}: {
	readonly sha: string
	readonly commit: CommitInfo | null
	readonly loading: boolean
	readonly className?: string
	readonly showIcon: boolean
}) {
	const resync = useAtomSet(MapleApiAtomClient.mutation("commits", "commitsResync"), {
		mode: "promiseExit",
	})

	const onOpenChange = useCallback(
		(open: boolean) => {
			if (!open || commit || loading) return
			if (RESYNC_ATTEMPTED.has(sha)) return
			RESYNC_ATTEMPTED.add(sha)
			void resync({
				payload: new CommitsResyncRequest({ sha }),
				reactivityKeys: ["commitLookup", sha],
			}).then((exit) => {
				if (!Exit.isSuccess(exit)) RESYNC_ATTEMPTED.delete(sha)
			})
		},
		[commit, loading, resync, sha],
	)

	const shortSha = commit?.shortSha ?? sha.slice(0, 7)

	return (
		<HoverCard onOpenChange={onOpenChange}>
			<HoverCardTrigger
				className={cn(
					"inline-flex items-center gap-1 font-mono text-xs",
					commit
						? "text-foreground hover:text-primary"
						: "text-muted-foreground decoration-dotted underline underline-offset-4",
					className,
				)}
			>
				{showIcon ? <GitCommitIcon size={12} className="opacity-60" /> : null}
				<span>{shortSha}</span>
			</HoverCardTrigger>
			<HoverCardContent className="w-[22rem] p-3">
				{commit ? (
					<CommitChipDetail commit={commit} />
				) : loading ? (
					<CommitChipSkeleton sha={sha} />
				) : (
					<UnresolvedCommitDetail sha={sha} />
				)}
			</HoverCardContent>
		</HoverCard>
	)
}

function initialsFor(name: string | null, login: string | null): string {
	if (name) {
		const parts = name.split(/\s+/).filter(Boolean)
		const result = parts.map((p) => p[0]?.toUpperCase() ?? "").join("").slice(0, 2)
		if (result) return result
	}
	if (login) return login.slice(0, 2).toUpperCase()
	return "??"
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	["year", 365 * 24 * 60 * 60 * 1000],
	["month", 30 * 24 * 60 * 60 * 1000],
	["week", 7 * 24 * 60 * 60 * 1000],
	["day", 24 * 60 * 60 * 1000],
	["hour", 60 * 60 * 1000],
	["minute", 60 * 1000],
]

function relativeTimeFrom(timestamp: number): string {
	const diff = timestamp - Date.now()
	const abs = Math.abs(diff)
	for (const [unit, ms] of RELATIVE_UNITS) {
		if (abs >= ms) return RELATIVE_TIME.format(Math.round(diff / ms), unit)
	}
	return "just now"
}

function CommitChipDetail({ commit }: { commit: CommitInfo }) {
	const author = commit.author
	const firstLine = commit.message.split("\n")[0]?.trim() ?? ""
	const repoPath =
		commit.repoOwner && commit.repoName ? `${commit.repoOwner}/${commit.repoName}` : null
	const repoUrl = repoPath ? `https://github.com/${repoPath}` : null
	const fullDate = new Date(commit.committedAt).toLocaleString()
	const visibleBranches = commit.branches.slice(0, 3)
	const hiddenBranchCount = Math.max(0, commit.branches.length - visibleBranches.length)
	return (
		<div className="flex flex-col">
			{/* Author */}
			<div className="flex items-center gap-2.5">
				<Avatar className="size-8 shrink-0">
					{author.avatarUrl ? <AvatarImage src={author.avatarUrl} alt="" /> : null}
					<AvatarFallback className="text-[10px]">
						{initialsFor(author.name, author.login)}
					</AvatarFallback>
				</Avatar>
				<div className="flex min-w-0 flex-col leading-tight">
					<span className="truncate text-sm font-semibold text-foreground">
						{author.name ?? author.login ?? "Unknown author"}
					</span>
					<span className="truncate text-[11px] text-muted-foreground">
						{author.login ? `@${author.login}` : author.email ?? "—"}
						{" · "}
						<span title={fullDate}>{relativeTimeFrom(commit.committedAt)}</span>
					</span>
				</div>
			</div>

			{/* Message */}
			<p className="mt-3 line-clamp-3 text-sm leading-snug text-foreground">{firstLine}</p>

			{/* Meta */}
			<div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2.5 text-[11px]">
				{repoUrl ? (
					<a
						href={repoUrl}
						target="_blank"
						rel="noreferrer"
						className="font-mono text-muted-foreground hover:text-foreground hover:underline"
					>
						{repoPath}
					</a>
				) : null}
				{repoUrl ? <span className="text-muted-foreground/60">·</span> : null}
				<a
					href={commit.htmlUrl}
					target="_blank"
					rel="noreferrer"
					className="font-mono text-muted-foreground hover:text-foreground hover:underline"
				>
					{commit.shortSha}
				</a>
				{visibleBranches.length > 0 ? (
					<>
						<span className="text-muted-foreground/60">·</span>
						<div className="flex flex-wrap items-center gap-1">
							{visibleBranches.map((branch) => (
								<span
									key={branch}
									className="rounded bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground"
								>
									{branch}
								</span>
							))}
							{hiddenBranchCount > 0 ? (
								<span className="text-[10px] text-muted-foreground/60">
									+{hiddenBranchCount}
								</span>
							) : null}
						</div>
					</>
				) : null}
			</div>

			<a
				href={commit.htmlUrl}
				target="_blank"
				rel="noreferrer"
				className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
			>
				View on GitHub
				<span aria-hidden>↗</span>
			</a>
		</div>
	)
}

function CommitChipSkeleton({ sha }: { sha: string }) {
	return (
		<div className="flex animate-pulse flex-col">
			<div className="flex items-center gap-2.5">
				<div className="size-8 shrink-0 rounded-full bg-muted" />
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<div className="h-3 w-24 rounded bg-muted" />
					<div className="h-2.5 w-32 rounded bg-muted/60" />
				</div>
			</div>
			<div className="mt-3 h-3 w-full rounded bg-muted" />
			<div className="mt-1.5 h-3 w-3/4 rounded bg-muted" />
			<div className="mt-3 border-t border-border/60 pt-2.5 font-mono text-[11px] text-muted-foreground">
				{sha.slice(0, 7)}
			</div>
		</div>
	)
}

function UnresolvedCommitDetail({ sha }: { sha: string }) {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
					<span className="text-[12px]">?</span>
				</div>
				<div className="flex min-w-0 flex-col leading-tight">
					<span className="text-sm font-semibold text-foreground">Unresolved commit</span>
					<span className="truncate font-mono text-[11px] text-muted-foreground">{sha}</span>
				</div>
			</div>
			<p className="text-[11px] leading-relaxed text-muted-foreground">
				This commit isn't in any connected repository yet. The repo might not be connected, the
				commit might live on an unsynced branch, or it might be local-only.
			</p>
			<p className="text-[11px] text-muted-foreground/80">A background lookup has been queued.</p>
		</div>
	)
}
