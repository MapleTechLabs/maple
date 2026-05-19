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
			<HoverCardContent className="w-80 p-3">
				{commit ? (
					<CommitChipDetail commit={commit} />
				) : loading ? (
					<div className="text-xs text-muted-foreground">Looking up commit…</div>
				) : (
					<UnresolvedCommitDetail sha={sha} />
				)}
			</HoverCardContent>
		</HoverCard>
	)
}

function CommitChipDetail({ commit }: { commit: CommitInfo }) {
	const author = commit.author
	const firstLine = commit.message.split("\n")[0]?.trim() ?? ""
	const initials = author.name
		?.split(/\s+/)
		.map((part) => part[0]?.toUpperCase())
		.filter(Boolean)
		.slice(0, 2)
		.join("") ?? author.login?.slice(0, 2).toUpperCase() ?? "??"
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-start gap-2">
				<Avatar className="size-7">
					{author.avatarUrl ? <AvatarImage src={author.avatarUrl} alt="" /> : null}
					<AvatarFallback>{initials}</AvatarFallback>
				</Avatar>
				<div className="flex flex-col gap-0.5">
					<span className="text-xs font-medium text-foreground">
						{author.name ?? author.login ?? "Unknown author"}
					</span>
					{author.login ? (
						<span className="text-[10px] text-muted-foreground">@{author.login}</span>
					) : null}
				</div>
			</div>
			<div className="text-xs text-foreground">{firstLine}</div>
			<div className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
				<div className="font-mono">
					{commit.repoOwner && commit.repoName
						? `${commit.repoOwner}/${commit.repoName}@`
						: ""}
					{commit.shortSha}
				</div>
				{commit.branches.length > 0 ? (
					<div>on {commit.branches.slice(0, 3).join(", ")}</div>
				) : null}
				<div>{new Date(commit.committedAt).toLocaleString()}</div>
			</div>
			<a
				href={commit.htmlUrl}
				target="_blank"
				rel="noreferrer"
				className="text-[11px] font-medium text-primary underline-offset-4 hover:underline"
			>
				Open on GitHub ↗
			</a>
		</div>
	)
}

function UnresolvedCommitDetail({ sha }: { sha: string }) {
	return (
		<div className="flex flex-col gap-1 text-xs">
			<div className="font-medium text-foreground">Commit not yet resolved</div>
			<div className="font-mono text-[10px] text-muted-foreground">{sha}</div>
			<ul className="list-disc pl-4 text-[11px] text-muted-foreground">
				<li>The repository may not be connected yet</li>
				<li>The commit may live on a branch we haven't synced</li>
				<li>The commit may be local-only (never pushed)</li>
			</ul>
			<div className="text-[11px] text-muted-foreground">
				We've queued a lookup in the background.
			</div>
		</div>
	)
}
