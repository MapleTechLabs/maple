import { useEffect, useRef, useState } from "react"
import { Exit } from "effect"
import {
	GithubSetTrackedBranchRequest,
	GithubStartConnectRequest,
	type GithubIntegrationStatus,
	type GithubRepoSummary,
	type VcsRepoSyncStatus,
} from "@maple/domain/http"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@maple/ui/components/ui/alert-dialog"
import { Button } from "@maple/ui/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toast } from "sonner"

import {
	ArrowPathIcon,
	CheckIcon,
	ChevronDownIcon,
	CircleCheckIcon,
	CircleWarningIcon,
	ClockIcon,
	ExternalLinkIcon,
	GithubIcon,
	LoaderIcon,
	TrashIcon,
} from "@/components/icons"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

/** GitHub's brand black — third-party brand color, no app token applies. */
export const GITHUB_ACCENT = "#181717"

/** How often to re-fetch status while the connect flow / background sync is active. */
const POLL_INTERVAL_MS = 3_000
/**
 * Keep polling for a bit after an action that triggers server-side work we can't yet
 * see in `status` — a closed connect popup (the install lands just after) or a
 * tracked-branch change (the backfill is enqueued; the repo flips to "backfilling"
 * once the worker picks it up). Bridges the gap until the repo's own sync status
 * takes over driving the poll.
 */
const FORCE_POLL_WINDOW_MS = 10_000

/** Visual presentation for each sync state — leading icon + short label + tone. */
const SYNC_PRESENTATION: Record<
	VcsRepoSyncStatus,
	{ label: string; tone: string; Icon: typeof CircleCheckIcon; spin?: boolean }
> = {
	ready: { label: "Synced", tone: "text-success-foreground", Icon: CircleCheckIcon },
	backfilling: { label: "Syncing", tone: "text-info-foreground", Icon: LoaderIcon, spin: true },
	pending: { label: "Queued", tone: "text-muted-foreground", Icon: ClockIcon },
	error: { label: "Sync failed", tone: "text-destructive-foreground", Icon: CircleWarningIcon },
}

function relativeFromMillis(ms: number): string {
	const diff = Date.now() - ms
	if (diff < 0) return "just now"
	const seconds = Math.floor(diff / 1000)
	if (seconds < 60) return "just now"
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}

export function GithubIntegrationCard() {
	// Assigned once so the refresh hook targets the same memoized query atom.
	const statusQuery = MapleApiAtomClient.query("integrations", "githubStatus", {
		reactivityKeys: ["githubIntegrationStatus"],
	})
	const statusResult = useAtomValue(statusQuery)
	const refreshStatus = useAtomRefresh(statusQuery)

	const startConnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "githubStart"), {
		mode: "promiseExit",
	})
	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "githubDisconnect"), {
		mode: "promiseExit",
	})
	const deleteRepository = useAtomSet(
		MapleApiAtomClient.mutation("integrations", "githubDeleteRepository"),
		{ mode: "promiseExit" },
	)
	const setTrackedBranch = useAtomSet(
		MapleApiAtomClient.mutation("integrations", "githubSetTrackedBranch"),
		{ mode: "promiseExit" },
	)

	const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null)
	// Manual-refresh spinner. Driven separately from the query's `waiting` flag so it
	// reflects only an explicit Refresh click — not the 3s background poll that also
	// flips `waiting` while a sync is in progress.
	const [refreshing, setRefreshing] = useState(false)
	// The removed repo awaiting delete confirmation, and the id mid-delete (so its
	// row shows a spinner). Keyed by Maple's repository id.
	const [repoToDelete, setRepoToDelete] = useState<GithubRepoSummary | null>(null)
	const [deletingRepoId, setDeletingRepoId] = useState<string | null>(null)
	// The connect popup handle and whether we're actively watching it, plus a short
	// "force poll" window opened after an action whose effect isn't yet in `status`
	// (popup close, tracked-branch change) — these, plus an in-progress sync, drive polling.
	const popupRef = useRef<Window | null>(null)
	const [popupOpen, setPopupOpen] = useState(false)
	const [forcePoll, setForcePoll] = useState(false)

	useEffect(() => {
		function onMessage(event: MessageEvent) {
			if (event.data?.type === "maple:integration:github") {
				if (event.data.status === "success") {
					toast.success("GitHub connected")
					refreshStatus()
				} else if (event.data.status === "error") {
					toast.error(event.data.message ?? "GitHub connection failed")
				}
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [refreshStatus])

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() => null)
	const isLoading = Result.isInitial(statusResult) && status === null

	// Repos backfill in the VcsSyncQueue worker after connect, so status keeps changing
	// server-side with no push channel. Poll while the connect popup is open, for a grace
	// window after it closes, and while any repo is still syncing (self-terminating).
	const syncing =
		status?.connected === true &&
		status.repositories.some(
			(r) => r.syncStatus === "pending" || r.syncStatus === "backfilling",
		)
	const shouldPoll = popupOpen || forcePoll || syncing

	useEffect(() => {
		if (!shouldPoll) return
		const id = setInterval(() => refreshStatus(), POLL_INTERVAL_MS)
		return () => clearInterval(id)
	}, [shouldPoll, refreshStatus])

	// Cross-origin popups fire no "closed" event, so poll the handle. When it closes,
	// open the grace window and refresh immediately rather than waiting a poll tick.
	useEffect(() => {
		if (!popupOpen) return
		const id = setInterval(() => {
			if (popupRef.current?.closed ?? true) {
				popupRef.current = null
				setPopupOpen(false)
				setForcePoll(true)
				refreshStatus()
			}
		}, 500)
		return () => clearInterval(id)
	}, [popupOpen, refreshStatus])

	useEffect(() => {
		if (!forcePoll) return
		const id = setTimeout(() => setForcePoll(false), FORCE_POLL_WINDOW_MS)
		return () => clearTimeout(id)
	}, [forcePoll])

	function handleManualRefresh() {
		refreshStatus()
		// Hold the spinner briefly so the refetch is perceptible even when it returns
		// almost instantly; the real data lands via the query result regardless.
		setRefreshing(true)
	}

	useEffect(() => {
		if (!refreshing) return
		const id = setTimeout(() => setRefreshing(false), 700)
		return () => clearTimeout(id)
	}, [refreshing])

	async function handleConnect() {
		const popup = window.open("", "maple-github-connect", "popup,width=600,height=720")
		popupRef.current = popup
		if (popup) setPopupOpen(true)
		setBusy("connect")
		const result = await startConnect({
			payload: new GithubStartConnectRequest({ returnTo: window.location.href }),
			reactivityKeys: ["githubIntegrationStatus"],
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			const url = result.value.redirectUrl
			if (popup && !popup.closed) {
				popup.location.href = url
			} else {
				const reopened = window.open(url, "maple-github-connect", "popup,width=600,height=720")
				popupRef.current = reopened
				if (reopened) setPopupOpen(true)
			}
		} else {
			popup?.close()
			popupRef.current = null
			setPopupOpen(false)
			toast.error("Failed to start GitHub connect flow")
		}
	}

	async function handleDisconnect() {
		setBusy("disconnect")
		const result = await disconnect({ reactivityKeys: ["githubIntegrationStatus"] })
		setBusy(null)
		if (Exit.isSuccess(result)) {
			toast.success("GitHub disconnected")
		} else {
			toast.error("Failed to disconnect GitHub")
		}
	}

	async function handleDeleteRepository(repo: GithubRepoSummary) {
		setRepoToDelete(null)
		setDeletingRepoId(repo.id)
		const result = await deleteRepository({
			params: { repositoryId: repo.id },
			reactivityKeys: ["githubIntegrationStatus"],
		})
		setDeletingRepoId(null)
		if (Exit.isSuccess(result)) {
			toast.success(`Deleted ${repo.fullName} from Maple`)
		} else {
			toast.error(`Failed to delete ${repo.fullName}`)
		}
	}

	async function handleSetTrackedBranch(repo: GithubRepoSummary, trackedBranch: string) {
		const result = await setTrackedBranch({
			params: { repositoryId: repo.id },
			payload: new GithubSetTrackedBranchRequest({ trackedBranch }),
			reactivityKeys: ["githubIntegrationStatus"],
		})
		if (Exit.isSuccess(result)) {
			if (result.value.backfillQueued) {
				toast.success(`Now tracking ${trackedBranch} — re-syncing commits…`)
				// The backfill is enqueued but the repo won't flip to "backfilling" until
				// the worker picks it up — poll through the gap so the row reflects the
				// re-sync (and its completion) without a manual refresh.
				setForcePoll(true)
				refreshStatus()
			}
		} else {
			toast.error("Failed to change tracked branch")
			// Surface failure so the selector can revert its optimistic state.
			throw new Error("Failed to change tracked branch")
		}
	}

	return (
		<>
			{isLoading ? (
				<LoadingState />
			) : status?.connected ? (
				<ConnectedView
					status={status}
					busy={busy}
					refreshing={refreshing}
					deletingRepoId={deletingRepoId}
					onRefresh={handleManualRefresh}
					onManage={handleConnect}
					onDisconnect={handleDisconnect}
					onRequestDelete={setRepoToDelete}
					onSetTrackedBranch={handleSetTrackedBranch}
				/>
			) : (
				<DisconnectedState busy={busy === "connect"} onConnect={handleConnect} />
			)}

			<AlertDialog
				open={repoToDelete !== null}
				onOpenChange={(open) => {
					if (!open) setRepoToDelete(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete repository from Maple</AlertDialogTitle>
						<AlertDialogDescription>
							This permanently removes{" "}
							<span className="font-medium text-foreground">{repoToDelete?.fullName}</span> and
							all of its synced commits from Maple. This cannot be undone. If you re-enable
							access in GitHub later, the repository will be re-synced from scratch.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (repoToDelete) void handleDeleteRepository(repoToDelete)
							}}
							className="bg-destructive text-white hover:bg-destructive/90"
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}

/** Skeleton placeholder shown while the first status fetch is in flight. */
function LoadingState() {
	return (
		<div className="space-y-4">
			<Skeleton className="h-16 w-full rounded-lg" />
			<div className="rounded-lg border border-border/60">
				<Skeleton className="h-11 w-full rounded-t-lg" />
				<div className="divide-y divide-border/40">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="m-3 h-9 rounded-md" />
					))}
				</div>
			</div>
		</div>
	)
}

/** First-run empty state: explains the value and offers the single connect action. */
function DisconnectedState({ busy, onConnect }: { busy: boolean; onConnect: () => void }) {
	return (
		<div className="flex flex-col items-center gap-5 rounded-lg border border-border/60 bg-card px-6 py-10 text-center">
			<span
				className="relative inline-flex size-14 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-card"
				style={{ ["--tile-accent" as string]: GITHUB_ACCENT }}
				aria-hidden
			>
				<span
					className="absolute inset-0 rounded-xl opacity-70"
					style={{
						background:
							"radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--tile-accent) 16%, transparent), transparent 70%)",
					}}
				/>
				<span className="relative text-foreground">
					<GithubIcon size={26} />
				</span>
			</span>

			<div className="flex max-w-md flex-col gap-1.5">
				<h3 className="text-base font-semibold">Connect your GitHub organization</h3>
				<p className="text-sm text-muted-foreground">
					Install the Maple GitHub App to sync repositories and commit history. Backfill runs in
					the background once connected.
				</p>
			</div>

			<ul className="flex w-full max-w-sm flex-col gap-2 text-left text-sm text-muted-foreground">
				{[
					"Sync commit history across your repositories",
					"Track one branch per repo, backfilled automatically",
					"Share all repositories or only the ones you pick",
				].map((feature) => (
					<li key={feature} className="flex items-start gap-2">
						<CheckIcon size={16} className="mt-0.5 shrink-0 text-success-foreground" />
						<span>{feature}</span>
					</li>
				))}
			</ul>

			<div className="flex flex-col items-center gap-2">
				<Button onClick={onConnect} disabled={busy}>
					{busy ? (
						<LoaderIcon size={16} className="animate-spin" />
					) : (
						<GithubIcon size={16} />
					)}
					Connect GitHub
				</Button>
				<p className="text-xs text-muted-foreground">
					You&apos;ll choose which repositories to share during install.
				</p>
			</div>
		</div>
	)
}

function ConnectedView({
	status,
	busy,
	refreshing,
	deletingRepoId,
	onRefresh,
	onManage,
	onDisconnect,
	onRequestDelete,
	onSetTrackedBranch,
}: {
	status: GithubIntegrationStatus
	busy: "connect" | "disconnect" | null
	refreshing: boolean
	deletingRepoId: string | null
	onRefresh: () => void
	onManage: () => void
	onDisconnect: () => void
	onRequestDelete: (repo: GithubRepoSummary) => void
	onSetTrackedBranch: (repo: GithubRepoSummary, branch: string) => Promise<void>
}) {
	const activeRepos = status.repositories.filter((r) => r.status === "active")
	const removedRepos = status.repositories.filter((r) => r.status === "removed")
	const counts = {
		synced: activeRepos.filter((r) => r.syncStatus === "ready").length,
		syncing: activeRepos.filter(
			(r) => r.syncStatus === "pending" || r.syncStatus === "backfilling",
		).length,
		failed: activeRepos.filter((r) => r.syncStatus === "error").length,
	}
	const scopeLabel =
		status.repositorySelection === "selected" ? "Selected repositories" : "All repositories"

	return (
		<div className="space-y-4">
			{/* Connection summary — green status, account, scope, and account-level actions. */}
			<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-card px-4 py-3">
				<div className="flex items-center gap-3">
					<span className="relative flex size-2.5 shrink-0" aria-hidden>
						<span className="absolute inline-flex size-full animate-ping rounded-full bg-success/60" />
						<span className="relative inline-flex size-2.5 rounded-full bg-success" />
					</span>
					<div className="leading-tight">
						<div className="text-sm font-medium">
							Connected
							{status.accountLogin ? (
								<>
									{" "}
									as{" "}
									<a
										href={`https://github.com/${status.accountLogin}`}
										target="_blank"
										rel="noreferrer"
										className="font-semibold hover:underline"
									>
										@{status.accountLogin}
									</a>
								</>
							) : null}
						</div>
						<div className="text-xs text-muted-foreground">
							{status.accountType === "organization"
								? "Organization"
								: status.accountType === "user"
									? "Personal account"
									: "GitHub App"}{" "}
							· {scopeLabel}
						</div>
					</div>
				</div>

				<div className="flex items-center gap-1.5">
					<Button
						size="sm"
						variant="ghost"
						onClick={onRefresh}
						disabled={refreshing}
						aria-label="Refresh status"
						title="Refresh status"
					>
						<ArrowPathIcon size={14} className={refreshing ? "animate-spin" : ""} />
						{refreshing ? "Refreshing…" : "Refresh"}
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={onManage}
						disabled={busy !== null}
					>
						{busy === "connect" ? (
							<LoaderIcon size={14} className="animate-spin" />
						) : null}
						Manage
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={onDisconnect}
						disabled={busy !== null}
					>
						{busy === "disconnect" ? (
							<LoaderIcon size={14} className="animate-spin" />
						) : null}
						Disconnect
					</Button>
				</div>
			</div>

			{/* Repositories panel. */}
			<div className="overflow-hidden rounded-lg border border-border/60 bg-card">
				<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
					<h3 className="text-sm font-medium">
						Repositories
						<span className="ml-1.5 text-muted-foreground">{activeRepos.length}</span>
					</h3>
					{activeRepos.length > 0 ? (
						<div className="flex items-center gap-3 text-xs text-muted-foreground">
							{counts.synced > 0 ? (
								<span className="flex items-center gap-1">
									<CircleCheckIcon size={13} className="text-success-foreground" />
									{counts.synced} synced
								</span>
							) : null}
							{counts.syncing > 0 ? (
								<span className="flex items-center gap-1">
									<LoaderIcon size={13} className="animate-spin text-info-foreground" />
									{counts.syncing} syncing
								</span>
							) : null}
							{counts.failed > 0 ? (
								<span className="flex items-center gap-1">
									<CircleWarningIcon size={13} className="text-destructive-foreground" />
									{counts.failed} failed
								</span>
							) : null}
						</div>
					) : null}
				</div>

				{activeRepos.length === 0 && removedRepos.length === 0 ? (
					<div className="flex items-center gap-2.5 px-4 py-6 text-sm text-muted-foreground">
						<LoaderIcon size={16} className="animate-spin" />
						Syncing repositories from GitHub… this can take a moment.
					</div>
				) : (
					<ul className="divide-y divide-border/40">
						{activeRepos.map((repo) => (
							<RepoRow
								key={repo.id}
								repo={repo}
								onSetTrackedBranch={(branch) => onSetTrackedBranch(repo, branch)}
							/>
						))}
					</ul>
				)}
			</div>

			{/* Repos GitHub revoked access to — kept (with history) until explicitly deleted. */}
			{removedRepos.length > 0 ? (
				<div className="overflow-hidden rounded-lg border border-border/60 bg-card">
					<div className="border-b border-border/60 px-4 py-2.5">
						<h3 className="flex items-center gap-1.5 text-sm font-medium">
							<CircleWarningIcon size={15} className="text-warning-foreground" />
							Needs attention
						</h3>
					</div>
					<ul className="divide-y divide-border/40">
						{removedRepos.map((repo) => (
							<li key={repo.id} className="flex items-center gap-3 px-4 py-3">
								<CircleWarningIcon
									size={17}
									className="shrink-0 text-warning-foreground"
								/>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<a
											href={repo.htmlUrl}
											target="_blank"
											rel="noreferrer"
											className="group inline-flex max-w-full items-center gap-1 truncate text-sm font-medium hover:underline"
										>
											<span className="truncate">{repo.fullName}</span>
											<ExternalLinkIcon
												size={12}
												className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
											/>
										</a>
										{repo.isPrivate ? (
											<span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
												Private
											</span>
										) : null}
									</div>
									<div className="text-xs text-muted-foreground">
										Access removed on GitHub · commit history kept
									</div>
								</div>
								<Button
									size="sm"
									variant="ghost"
									className="shrink-0 text-destructive-foreground hover:bg-destructive/10"
									onClick={() => onRequestDelete(repo)}
									disabled={deletingRepoId !== null}
								>
									{deletingRepoId === repo.id ? (
										<LoaderIcon size={13} className="animate-spin" />
									) : (
										<TrashIcon size={13} />
									)}
									Delete
								</Button>
							</li>
						))}
					</ul>
					<p className="border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
						Re-enable these in the{" "}
						<a
							href="https://github.com/settings/installations"
							target="_blank"
							rel="noreferrer"
							className="font-medium underline underline-offset-2 hover:text-foreground"
						>
							Maple GitHub App
						</a>{" "}
						to resume syncing. Deleting removes their synced commits permanently.
					</p>
				</div>
			) : null}
		</div>
	)
}

/** A single active repository: leading sync-status icon, name + meta, tracked-branch picker. */
function RepoRow({
	repo,
	onSetTrackedBranch,
}: {
	repo: GithubRepoSummary
	onSetTrackedBranch: (branch: string) => Promise<void>
}) {
	const presentation = SYNC_PRESENTATION[repo.syncStatus]
	const StatusIcon = presentation.Icon

	return (
		<li className="flex items-center gap-3 px-4 py-3">
			<StatusIcon
				size={17}
				className={`shrink-0 ${presentation.tone} ${presentation.spin ? "animate-spin" : ""}`}
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<a
						href={repo.htmlUrl}
						target="_blank"
						rel="noreferrer"
						className="group inline-flex max-w-full items-center gap-1 truncate text-sm font-medium hover:underline"
					>
						<span className="truncate">{repo.fullName}</span>
						<ExternalLinkIcon
							size={12}
							className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
						/>
					</a>
					{repo.isPrivate ? (
						<span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							Private
						</span>
					) : null}
				</div>
				<div className="flex items-center gap-1.5 text-xs">
					<span className={presentation.tone}>{presentation.label}</span>
					{repo.syncStatus === "error" && repo.lastSyncError ? (
						<span className="truncate text-muted-foreground" title={repo.lastSyncError}>
							· {repo.lastSyncError}
						</span>
					) : repo.lastSyncedAt ? (
						<span className="text-muted-foreground">
							· {relativeFromMillis(repo.lastSyncedAt)}
						</span>
					) : null}
				</div>
			</div>
			<BranchSelector repo={repo} onSelect={onSetTrackedBranch} />
		</li>
	)
}

/**
 * Per-repo tracked-branch selector. A repo tracks exactly one branch (seeded to
 * its default); only that branch's commits are synced. Picking a different branch
 * is destructive — it wipes the repo's stored commits and re-backfills the new
 * branch — so it routes through a confirmation dialog. Selection is optimistic and
 * reverts if the save fails.
 */
function BranchSelector({
	repo,
	onSelect,
}: {
	repo: GithubRepoSummary
	onSelect: (trackedBranch: string) => Promise<void>
}) {
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState("")
	const [saving, setSaving] = useState(false)
	// Optimistic view of the tracked branch; falls back to the default like the API.
	const serverTracked =
		repo.trackedBranch ?? repo.branches.find((b) => b.isDefault)?.name ?? null
	const [tracked, setTracked] = useState<string | null>(serverTracked)
	// The branch awaiting change confirmation (destructive: wipes + resyncs).
	const [pending, setPending] = useState<string | null>(null)

	// Re-sync local selection whenever the server state changes (after a save).
	useEffect(() => {
		setTracked(repo.trackedBranch ?? repo.branches.find((b) => b.isDefault)?.name ?? null)
	}, [repo.trackedBranch, repo.branches])

	// Nothing to offer until branches have synced.
	if (repo.branches.length === 0) return null

	const filtered = query
		? repo.branches.filter((b) => b.name.toLowerCase().includes(query.toLowerCase()))
		: repo.branches

	async function commit(name: string) {
		const prev = tracked
		setTracked(name)
		setSaving(true)
		setOpen(false)
		try {
			await onSelect(name)
		} catch {
			setTracked(prev) // revert on failure
		} finally {
			setSaving(false)
		}
	}

	function pick(name: string) {
		if (name === tracked) {
			setOpen(false)
			return
		}
		// Defer the destructive change to an explicit confirmation.
		setPending(name)
	}

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger
					render={
						<Button
							size="sm"
							variant="outline"
							className="h-7 shrink-0 gap-1.5 px-2.5 font-normal"
							disabled={saving}
						>
							{saving ? (
								<LoaderIcon size={12} className="animate-spin" />
							) : null}
							<span className="text-muted-foreground">branch</span>
							<span className="max-w-[10rem] truncate font-medium">{tracked ?? "—"}</span>
							<ChevronDownIcon size={12} className="text-muted-foreground" />
						</Button>
					}
				/>
				<PopoverContent align="end" className="w-72 p-0">
					<div className="border-b border-border/60 px-3 py-2.5">
						<p className="text-xs font-medium text-foreground">Tracked branch</p>
						<p className="mt-0.5 text-[11px] text-muted-foreground">
							Maple syncs commits from the one branch you track. Changing it re-syncs this
							repo&apos;s commits from the new branch.
						</p>
					</div>
					{repo.branches.length > 8 ? (
						<div className="border-b border-border/60 p-2">
							<input
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search branches…"
								className="w-full rounded-md border border-border/60 bg-transparent px-2 py-1 text-xs outline-none focus:border-border"
							/>
						</div>
					) : null}
					<div className="max-h-56 overflow-y-auto p-1">
						{filtered.length === 0 ? (
							<p className="px-2 py-1.5 text-[11px] text-muted-foreground">No matches.</p>
						) : (
							filtered.map((b) => {
								const selected = b.name === tracked
								return (
									<button
										type="button"
										key={b.name}
										onClick={() => pick(b.name)}
										className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/50"
									>
										<CheckIcon
											size={14}
											className={`shrink-0 ${selected ? "text-foreground" : "text-transparent"}`}
										/>
										<span className="truncate">{b.name}</span>
										{b.isDefault ? (
											<span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
												default
											</span>
										) : null}
									</button>
								)
							})
						)}
					</div>
				</PopoverContent>
			</Popover>

			<AlertDialog
				open={pending !== null}
				onOpenChange={(o) => {
					if (!o) setPending(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Change tracked branch</AlertDialogTitle>
						<AlertDialogDescription>
							This switches{" "}
							<span className="font-medium text-foreground">{repo.fullName}</span> to track{" "}
							<span className="font-medium text-foreground">{pending}</span>. Maple deletes
							this repo&apos;s currently synced commits and re-syncs the last 90 days from{" "}
							<span className="font-medium text-foreground">{pending}</span>.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								const next = pending
								setPending(null)
								if (next) void commit(next)
							}}
						>
							Track branch
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
