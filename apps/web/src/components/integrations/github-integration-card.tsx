import { useEffect, useRef, useState } from "react"
import { Exit } from "effect"
import {
	GithubSetTrackedBranchRequest,
	GithubStartConnectRequest,
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
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { toast } from "sonner"

import { GithubIcon, LoaderIcon } from "@/components/icons"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

/** GitHub's brand black — third-party brand color, no app token applies. */
export const GITHUB_ACCENT = "#181717"

const SYNC_LABEL: Record<VcsRepoSyncStatus, string> = {
	pending: "Pending",
	backfilling: "Backfilling",
	ready: "Ready",
	error: "Error",
}

const SYNC_VARIANT: Record<VcsRepoSyncStatus, "success" | "info" | "outline" | "error"> = {
	pending: "outline",
	backfilling: "info",
	ready: "success",
	error: "error",
}

/** How often to re-fetch status while the connect flow / background sync is active. */
const POLL_INTERVAL_MS = 3_000
/** Keep polling for a bit after the connect popup closes — the install lands server-side just after. */
const POST_CLOSE_GRACE_MS = 10_000

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
	// The removed repo awaiting delete confirmation, and the id mid-delete (so its
	// row shows a spinner). Keyed by Maple's repository id.
	const [repoToDelete, setRepoToDelete] = useState<GithubRepoSummary | null>(null)
	const [deletingRepoId, setDeletingRepoId] = useState<string | null>(null)
	// The connect popup handle, whether we're actively watching it, and its post-close
	// grace window — these (plus in-progress sync) drive status polling.
	const popupRef = useRef<Window | null>(null)
	const [popupOpen, setPopupOpen] = useState(false)
	const [inGrace, setInGrace] = useState(false)

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

	// Repos backfill in the VcsSyncQueue worker after connect, so status keeps changing
	// server-side with no push channel. Poll while the connect popup is open, for a grace
	// window after it closes, and while any repo is still syncing (self-terminating).
	const syncing =
		status?.connected === true &&
		status.repositories.some(
			(r) => r.syncStatus === "pending" || r.syncStatus === "backfilling",
		)
	const shouldPoll = popupOpen || inGrace || syncing

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
				setInGrace(true)
				refreshStatus()
			}
		}, 500)
		return () => clearInterval(id)
	}, [popupOpen, refreshStatus])

	useEffect(() => {
		if (!inGrace) return
		const id = setTimeout(() => setInGrace(false), POST_CLOSE_GRACE_MS)
		return () => clearTimeout(id)
	}, [inGrace])

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
			}
		} else {
			toast.error("Failed to change tracked branch")
			// Surface failure so the selector can revert its optimistic state.
			throw new Error("Failed to change tracked branch")
		}
	}

	const isConnected = status?.connected === true

	return (
		<>
			<div
				className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4"
				style={{ ["--tile-accent" as string]: GITHUB_ACCENT }}
			>
				<span
					className="relative inline-flex size-12 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-card"
					aria-hidden
				>
					<span
						className="absolute inset-0 rounded-lg opacity-70"
						style={{
							background:
								"radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--tile-accent) 16%, transparent), transparent 70%)",
						}}
					/>
					<span className="relative text-foreground">
						<GithubIcon size={22} />
					</span>
				</span>

				<div className="flex flex-1 flex-col gap-2">
					<div className="flex items-start justify-between gap-3">
						<div>
							<div className="flex items-center gap-2">
								<h3 className="text-sm font-semibold">GitHub</h3>
								{isConnected ? (
									<span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success-foreground">
										Connected
									</span>
								) : (
									<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
										Not connected
									</span>
								)}
							</div>
							<p className="mt-1 text-xs text-muted-foreground">
								Install the Maple GitHub App to sync repositories and commits. Backfill runs
								in the background once connected.
							</p>
						</div>
					</div>

					{status && status.connected ? (
						<div className="flex flex-col gap-2 rounded-md bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
							<div className="flex items-center justify-between gap-2">
								<div>
									Connected
									{status.accountLogin ? (
										<>
											{" "}
											as{" "}
											<span className="font-medium text-foreground">
												@{status.accountLogin}
											</span>
										</>
									) : null}
									{status.repositorySelection === "selected"
										? " · selected repositories"
										: " · all repositories"}
								</div>
								<button
									type="button"
									onClick={() => refreshStatus()}
									className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
								>
									Refresh
								</button>
							</div>
							{status.repositories.length === 0 ? (
								<div>
									Syncing repositories… this can take a moment. Use Refresh to check
									progress.
								</div>
							) : (
								<>
									<ul className="flex flex-col divide-y divide-border/40">
										{status.repositories.map((repo) => {
											const isRemoved = repo.status === "removed"
											return (
												<li
													key={repo.id}
													className="flex items-center justify-between gap-2 py-1.5"
												>
													<a
														href={repo.htmlUrl}
														target="_blank"
														rel="noreferrer"
														className={`truncate hover:underline ${
															isRemoved
																? "text-muted-foreground"
																: "text-foreground"
														}`}
													>
														{repo.fullName}
													</a>
													<div className="flex shrink-0 items-center gap-1.5">
														{repo.isPrivate ? (
															<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
																Private
															</span>
														) : null}
														{isRemoved ? (
															<>
																<Badge variant="warning" size="sm">
																	Access removed
																</Badge>
																<Button
																	size="sm"
																	variant="ghost"
																	className="h-6 px-2 text-[11px] text-destructive-foreground hover:bg-destructive/10"
																	onClick={() => setRepoToDelete(repo)}
																	disabled={deletingRepoId !== null}
																>
																	{deletingRepoId === repo.id ? (
																		<LoaderIcon
																			size={12}
																			className="animate-spin"
																		/>
																	) : null}
																	Delete
																</Button>
															</>
														) : (
															<>
																<BranchSelector
																	repo={repo}
																	onSelect={(branch) =>
																		handleSetTrackedBranch(repo, branch)
																	}
																/>
																<Badge
																	variant={SYNC_VARIANT[repo.syncStatus]}
																	size="sm"
																>
																	{SYNC_LABEL[repo.syncStatus]}
																</Badge>
															</>
														)}
													</div>
												</li>
											)
										})}
									</ul>
									{status.repositories.some((r) => r.status === "removed") ? (
										<p className="text-[11px] text-muted-foreground">
											Repositories marked{" "}
											<span className="font-medium">Access removed</span> lost access on
											GitHub. Re-enable them in the{" "}
											<a
												href="https://github.com/settings/installations"
												target="_blank"
												rel="noreferrer"
												className="underline underline-offset-2 hover:text-foreground"
											>
												Maple GitHub App
											</a>{" "}
											to resume syncing — their commit history is kept. Deleting a
											repository removes all of its synced commits from Maple
											permanently.
										</p>
									) : null}
								</>
							)}
						</div>
					) : null}

					<div className="flex flex-wrap gap-2">
						{isConnected ? (
							<>
								<Button
									size="sm"
									onClick={handleConnect}
									disabled={busy !== null}
									variant="outline"
								>
									{busy === "connect" ? (
										<LoaderIcon size={14} className="animate-spin" />
									) : null}
									Reconnect
								</Button>
								<Button
									size="sm"
									onClick={handleDisconnect}
									disabled={busy !== null}
									variant="outline"
								>
									{busy === "disconnect" ? (
										<LoaderIcon size={14} className="animate-spin" />
									) : null}
									Disconnect
								</Button>
							</>
						) : (
							<Button
								size="sm"
								onClick={handleConnect}
								disabled={busy !== null}
								style={{
									background: GITHUB_ACCENT,
									borderColor: GITHUB_ACCENT,
									color: "#fff",
								}}
							>
								{busy === "connect" ? (
									<LoaderIcon size={14} className="animate-spin" />
								) : null}
								Connect GitHub
							</Button>
						)}
					</div>
				</div>
			</div>

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
							variant="ghost"
							className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
							disabled={saving}
						>
							{saving ? <LoaderIcon size={12} className="animate-spin" /> : null}
							Branch: <span className="font-medium text-foreground">{tracked ?? "—"}</span>
						</Button>
					}
				/>
				<PopoverContent align="end" className="w-72">
					<div className="flex flex-col gap-2">
						<div>
							<p className="text-xs font-medium text-foreground">Tracked branch</p>
							<p className="text-[11px] text-muted-foreground">
								Maple syncs commits from the one branch you track. Changing it re-syncs
								this repo's commits from the new branch.
							</p>
						</div>
						{repo.branches.length > 8 ? (
							<input
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search branches…"
								className="rounded-md border border-border/60 bg-transparent px-2 py-1 text-xs outline-none focus:border-border"
							/>
						) : null}
						<div className="-mx-1 max-h-56 overflow-y-auto">
							{filtered.length === 0 ? (
								<p className="px-1 py-1.5 text-[11px] text-muted-foreground">No matches.</p>
							) : (
								filtered.map((b) => (
									<button
										type="button"
										key={b.name}
										onClick={() => pick(b.name)}
										className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-left text-xs hover:bg-muted/50"
									>
										<span
											className={`size-3.5 shrink-0 rounded-full border ${
												b.name === tracked
													? "border-success bg-success"
													: "border-border/60"
											}`}
											aria-hidden
										/>
										<span className="truncate">{b.name}</span>
										{b.isDefault ? (
											<span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
												default
											</span>
										) : null}
									</button>
								))
							)}
						</div>
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
							this repo's currently synced commits and re-syncs the last 90 days from{" "}
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
