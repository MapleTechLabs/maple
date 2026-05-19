import { useEffect, useState } from "react"
import { Exit } from "effect"
import {
	GithubSetRepoSyncRequest,
	GithubStartConnectRequest,
} from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Switch } from "@maple/ui/components/ui/switch"
import { toast } from "sonner"

import { GithubIcon, LoaderIcon } from "@/components/icons"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

const REACTIVITY_KEYS = {
	status: ["githubIntegrationStatus"],
	installations: ["githubInstallations"],
	repositories: (installationId: string) => ["githubRepositories", installationId],
}

export function GitHubIntegrationCard() {
	const statusAtom = MapleApiAtomClient.query("github", "githubStatus", {
		reactivityKeys: REACTIVITY_KEYS.status,
	})
	const installationsAtom = MapleApiAtomClient.query("github", "githubListInstallations", {
		reactivityKeys: REACTIVITY_KEYS.installations,
	})

	const statusResult = useAtomValue(statusAtom)
	const installationsResult = useAtomValue(installationsAtom)
	const refreshStatus = useAtomRefresh(statusAtom)
	const refreshInstallations = useAtomRefresh(installationsAtom)

	const startConnect = useAtomSet(MapleApiAtomClient.mutation("github", "githubStart"), {
		mode: "promiseExit",
	})
	const disconnect = useAtomSet(MapleApiAtomClient.mutation("github", "githubDisconnect"), {
		mode: "promiseExit",
	})

	const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null)
	const [pendingConnect, setPendingConnect] = useState(false)

	useEffect(() => {
		function onMessage(event: MessageEvent) {
			if (event.data?.type === "maple:integration:github") {
				setPendingConnect(false)
				if (event.data.status === "success") {
					toast.success(event.data.message ?? "GitHub connected")
					refreshStatus()
					refreshInstallations()
				} else if (event.data.status === "error") {
					toast.error(event.data.message ?? "GitHub connection failed")
				}
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [refreshStatus, refreshInstallations])

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() => null)
	const installations = Result.builder(installationsResult)
		.onSuccess((s) => s.installations)
		.orElse(() => [])

	const isConfigured = status?.configured === true
	const hasInstallations = installations.length > 0

	async function handleConnect() {
		const popup = window.open("", "maple-github-connect", "popup,width=720,height=720")
		setBusy("connect")
		setPendingConnect(true)
		const result = await startConnect({
			payload: new GithubStartConnectRequest({ returnTo: window.location.href }),
			reactivityKeys: REACTIVITY_KEYS.status,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			const url = result.value.redirectUrl
			if (popup) popup.location.href = url
			else window.open(url, "maple-github-connect", "popup,width=720,height=720")
		} else {
			popup?.close()
			setPendingConnect(false)
			toast.error("Failed to start GitHub install flow")
		}
	}

	async function handleDisconnect(installationDbId: string) {
		setBusy("disconnect")
		const result = await disconnect({
			params: { installationId: installationDbId },
			reactivityKeys: [
				...REACTIVITY_KEYS.installations,
				...REACTIVITY_KEYS.status,
			],
		})
		setBusy(null)
		refreshStatus()
		refreshInstallations()
		if (Exit.isSuccess(result)) {
			toast.success("GitHub installation suspended")
			if (result.value.uninstallUrl) {
				toast.info("To fully remove the integration, uninstall on GitHub", {
					action: {
						label: "Open GitHub",
						onClick: () => window.open(result.value.uninstallUrl ?? "", "_blank", "noreferrer"),
					},
				})
			}
		} else {
			toast.error("Failed to disconnect GitHub installation")
		}
	}

	return (
		<div
			className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4"
			style={{ ["--tile-accent" as string]: "#1f2328" }}
		>
			<span
				className="relative inline-flex size-12 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-card"
				aria-hidden
			>
				<span className="relative text-foreground">
					<GithubIcon size={22} />
				</span>
			</span>

			<div className="flex flex-1 flex-col gap-2">
				<div className="flex items-start justify-between gap-3">
					<div>
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-semibold">GitHub</h3>
							{pendingConnect && !hasInstallations ? (
								<span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-400">
									<LoaderIcon size={10} className="animate-spin" />
									Connecting…
								</span>
							) : hasInstallations ? (
								<span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-400">
									{installations.length} installation{installations.length === 1 ? "" : "s"}
								</span>
							) : (
								<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
									Not connected
								</span>
							)}
						</div>
						<p className="mt-1 text-xs text-muted-foreground">
							Connect a GitHub App installation so commit SHAs in traces resolve to author,
							message, and a deep link. You can install on multiple GitHub orgs.
						</p>
					</div>
				</div>

				{!isConfigured && status ? (
					<div className="rounded-md bg-amber-500/10 px-3 py-2 text-[11px] text-amber-400">
						GitHub App not configured on this Maple instance. Missing:{" "}
						<span className="font-mono">{status.missingEnv.join(", ")}</span>.
					</div>
				) : null}

				{installations.map((installation) => (
					<InstallationBlock
						key={installation.id}
						installation={installation}
						onDisconnect={() => handleDisconnect(installation.id)}
						busy={busy === "disconnect"}
					/>
				))}

				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						onClick={handleConnect}
						disabled={busy !== null || !isConfigured}
						style={{ background: "#1f2328", borderColor: "#1f2328", color: "#fff" }}
					>
						{busy === "connect" ? <LoaderIcon size={14} className="animate-spin" /> : null}
						{hasInstallations ? "Add another GitHub installation" : "Connect GitHub"}
					</Button>
				</div>
			</div>
		</div>
	)
}

interface InstallationBlockProps {
	installation: {
		readonly id: string
		readonly accountLogin: string
		readonly accountAvatarUrl: string | null
		readonly accountType: "User" | "Organization"
		readonly repositorySelection: "all" | "selected"
		readonly suspendedAt: number | null
		readonly repositoryCount: number
	}
	onDisconnect: () => void
	busy: boolean
}

function InstallationBlock({ installation, onDisconnect, busy }: InstallationBlockProps) {
	const reposAtom = MapleApiAtomClient.query("github", "githubListRepositories", {
		params: { installationId: installation.id },
		reactivityKeys: REACTIVITY_KEYS.repositories(installation.id),
	})
	const reposResult = useAtomValue(reposAtom)
	const refreshRepos = useAtomRefresh(reposAtom)
	const setSync = useAtomSet(MapleApiAtomClient.mutation("github", "githubSetRepoSync"), {
		mode: "promiseExit",
	})
	const backfill = useAtomSet(MapleApiAtomClient.mutation("github", "githubBackfillRepo"), {
		mode: "promiseExit",
	})

	const repositories = Result.builder(reposResult)
		.onSuccess((s) => s.repositories)
		.orElse(() => [])

	const isSuspended = installation.suspendedAt !== null
	const anyRunning = repositories.some((r) => r.backfillStatus === "running")

	// Auto-poll the repo list every 2s while any repo is mid-backfill so the
	// UI reflects status + commit count transitions without a manual refresh.
	useEffect(() => {
		if (!anyRunning) return
		const handle = setInterval(refreshRepos, 2000)
		return () => clearInterval(handle)
	}, [anyRunning, refreshRepos])

	async function toggleSync(repositoryId: string, enabled: boolean) {
		const result = await setSync({
			params: { repositoryId },
			payload: new GithubSetRepoSyncRequest({ enabled }),
			reactivityKeys: REACTIVITY_KEYS.repositories(installation.id),
		})
		if (!Exit.isSuccess(result)) {
			toast.error("Failed to update sync setting")
		}
	}

	async function runBackfill(repositoryId: string, label: string) {
		const result = await backfill({
			params: { repositoryId },
			reactivityKeys: REACTIVITY_KEYS.repositories(installation.id),
		})
		if (Exit.isSuccess(result)) {
			toast.success(`Backfill queued for ${label}`)
			refreshRepos()
		} else {
			toast.error("Failed to queue backfill")
		}
	}

	return (
		<div className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11px]">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					{installation.accountAvatarUrl ? (
						<img
							src={installation.accountAvatarUrl}
							alt=""
							className="size-6 rounded-full border border-border/60"
						/>
					) : null}
					<div className="flex flex-col">
						<span className="font-mono text-foreground">
							{installation.accountType === "Organization" ? "" : "@"}
							{installation.accountLogin}
						</span>
						<span className="text-muted-foreground">
							{installation.repositorySelection === "all"
								? "All repositories"
								: `${installation.repositoryCount} repositor${installation.repositoryCount === 1 ? "y" : "ies"} selected`}
							{isSuspended ? " · Suspended" : ""}
						</span>
					</div>
				</div>
				<Button
					size="sm"
					variant="outline"
					onClick={onDisconnect}
					disabled={busy}
				>
					Disconnect
				</Button>
			</div>
			{repositories.length > 0 ? (
				<div className="flex flex-col gap-1 pt-1">
					{repositories.map((repo) => {
						const statusColor =
							repo.backfillStatus === "complete"
								? "text-emerald-400"
								: repo.backfillStatus === "running"
									? "text-blue-400"
									: repo.backfillStatus === "failed"
										? "text-red-400"
										: "text-muted-foreground"
						return (
							<div
								key={repo.id}
								className="flex items-center justify-between gap-2 rounded bg-background/60 px-2 py-1"
							>
								<div className="flex flex-col">
									<span className="font-mono text-foreground">
										{repo.owner}/{repo.name}
									</span>
									<span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
										<span>default: {repo.defaultBranch}</span>
										<span>·</span>
										<span className={statusColor}>
											{repo.backfillStatus === "running" ? (
												<span className="inline-flex items-center gap-1">
													<LoaderIcon size={9} className="animate-spin" />
													Backfilling…
												</span>
											) : (
												repo.backfillStatus
											)}
										</span>
										<span>·</span>
										<span>
											{repo.commitCount} commit{repo.commitCount === 1 ? "" : "s"}
										</span>
										{repo.backfillError ? (
											<>
												<span>·</span>
												<span className="text-red-400" title={repo.backfillError}>
													error
												</span>
											</>
										) : null}
									</span>
								</div>
								<div className="flex items-center gap-2">
									<Button
										size="sm"
										variant="outline"
										onClick={() => runBackfill(repo.id, `${repo.owner}/${repo.name}`)}
										disabled={repo.backfillStatus === "running"}
									>
										Backfill
									</Button>
									<Switch
										checked={repo.syncEnabled}
										onCheckedChange={(checked) => toggleSync(repo.id, checked)}
										aria-label={`Toggle sync for ${repo.owner}/${repo.name}`}
									/>
								</div>
							</div>
						)
					})}
				</div>
			) : null}
		</div>
	)
}
