import { useState } from "react"
import { Exit, Option, Schema } from "effect"
import { Link } from "@tanstack/react-router"
import { RailwayConnectRequest, type RailwayIntegrationStatus } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toastManager } from "@maple/ui/components/ui/toast"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

import { ErrorState } from "@/components/common/error-state"
import { ExternalLinkIcon, LoaderIcon, RailwayIcon } from "@/components/icons"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { errorMessage } from "@/lib/error-toast"
import { MapleApiAtomClient, retainedQuery } from "@/lib/services/common/atom-client"
import { IntegrationIconPlate, RAILWAY_ACCENT } from "./integration-catalog"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyFooter,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"

const TOKENS_URL = "https://railway.com/account/tokens"

const decodeConnectRequest = Schema.decodeUnknownOption(RailwayConnectRequest)

export const railwayStatusAtom = retainedQuery("integrations", "railwayStatus", {
	reactivityKeys: ["railwayIntegrationStatus"],
})

/** Fast enough to see a queued environment land, slow enough to be free next to the poller. */
const SETTLING_REFRESH_MS = 15_000

/** Environments the poller hasn't completed a first sync for yet (and hasn't failed on). */
export const unsyncedEnvironments = (status: RailwayIntegrationStatus) =>
	status.environments.filter(
		(environment) => environment.lastSyncedAt === null && environment.lastError === null,
	).length

function connectedToast(status: RailwayIntegrationStatus, mode: "connect" | "rotate") {
	const synced = status.environments.filter((environment) => environment.lastSyncedAt !== null).length
	// A first sync that failed has an error but no sync time; it is neither synced nor waiting.
	const failed = status.environments.filter(
		(environment) => environment.lastSyncedAt === null && environment.lastError !== null,
	).length
	const queued = unsyncedEnvironments(status)
	return {
		title: mode === "rotate" ? "Railway token updated" : "Railway connected",
		description:
			status.environments.length === 0
				? "This token can't see any projects yet."
				: failed > 0
					? `${plural(synced, "environment")} synced, ${failed} failed. The rows below say why.`
					: queued === 0
						? `Pulled the last hour of metrics for ${plural(synced, "environment")}.`
						: `${plural(synced, "environment")} synced, ${queued} more within 5 minutes.`,
		type: "success" as const,
	}
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

function RailwayTokenForm({
	mode,
	onSaved,
	onCancel,
}: {
	mode: "connect" | "rotate"
	onSaved?: () => void
	onCancel?: () => void
}) {
	const connect = useAtomSet(MapleApiAtomClient.mutation("integrations", "railwayConnect"), {
		mode: "promiseExit",
	})
	const [token, setToken] = useState("")
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	// Decoding builds the class instance v1 payloads need (a plain object is never sent) and
	// checks the length rules without the constructor's throw.
	const request = decodeConnectRequest({ token: token.trim() })
	const tokenInvalid = token.trim().length > 0 && Option.isNone(request)

	async function handleSubmit(event: React.FormEvent) {
		event.preventDefault()
		if (Option.isNone(request)) return
		setSubmitting(true)
		setError(null)
		const result = await connect({
			payload: request.value,
			reactivityKeys: ["railwayIntegrationStatus"],
		})
		setSubmitting(false)
		if (Exit.isSuccess(result)) {
			toastManager.add(connectedToast(result.value, mode))
			setToken("")
			onSaved?.()
			return
		}
		// Railway's rejection reason is the actionable part; keep it on screen.
		setError(errorMessage(result, "Failed to connect Railway."))
	}

	return (
		<form onSubmit={handleSubmit} className="flex w-full flex-col gap-2 text-left">
			<Label htmlFor="railway-token">Account or workspace token</Label>
			<div className="flex flex-wrap items-center gap-2">
				<Input
					id="railway-token"
					type="password"
					autoComplete="off"
					placeholder="Paste a Railway API token"
					value={token}
					onChange={(event) => setToken(event.target.value)}
					className="min-w-48 flex-1"
				/>
				{onCancel !== undefined ? (
					<Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
						Cancel
					</Button>
				) : null}
				<Button type="submit" disabled={Option.isNone(request) || submitting}>
					{submitting ? (
						<LoaderIcon size={14} className="animate-spin" />
					) : (
						<RailwayIcon size={14} />
					)}
					{submitting ? "Connecting…" : mode === "rotate" ? "Update token" : "Connect Railway"}
				</Button>
			</div>
			{submitting ? (
				<p className="text-xs text-muted-foreground" aria-live="polite">
					Checking the token and pulling the last hour of metrics. This takes a few seconds.
				</p>
			) : error !== null ? (
				<p className="text-xs text-severity-error" role="alert">
					{error}
				</p>
			) : tokenInvalid ? (
				<p className="text-xs text-muted-foreground">
					A Railway token is between 8 and 512 characters.
				</p>
			) : null}
		</form>
	)
}

export function RailwayIntegrationCard() {
	const statusResult = useAtomValue(railwayStatusAtom)
	const refreshStatus = useAtomRefresh(railwayStatusAtom)
	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "railwayDisconnect"), {
		mode: "promiseExit",
	})
	const sync = useAtomSet(MapleApiAtomClient.mutation("integrations", "railwaySync"), {
		mode: "promiseExit",
	})
	const [disconnectBusy, setDisconnectBusy] = useState(false)
	const [syncBusy, setSyncBusy] = useState(false)
	const [rotating, setRotating] = useState(false)

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() =>
			Result.isFailure(statusResult)
				? Option.getOrNull(Option.map(statusResult.previousSuccess, (previous) => previous.value))
				: null,
		)

	const queued = status?.connected && !status.authFailed ? unsyncedEnvironments(status) : 0
	// Poll while environments are still waiting on their first sync so the rows land on their own.
	useIntervalRefresh(refreshStatus, { intervalMs: SETTLING_REFRESH_MS, enabled: queued > 0 })

	if (Result.isInitial(statusResult) && status === null) {
		return <Skeleton className="h-32 w-full rounded-lg" />
	}
	if (Result.isFailure(statusResult) && status === null) {
		return (
			<ErrorState
				error={statusResult.cause}
				title="Failed to load the Railway integration"
				onRetry={refreshStatus}
			/>
		)
	}

	async function handleDisconnect() {
		setDisconnectBusy(true)
		const result = await disconnect({ reactivityKeys: ["railwayIntegrationStatus"] })
		setDisconnectBusy(false)
		toastManager.add(
			Exit.isSuccess(result)
				? { title: "Railway disconnected", type: "success" }
				: { title: "Failed to disconnect Railway", type: "error" },
		)
	}

	async function handleSync() {
		setSyncBusy(true)
		const result = await sync({ reactivityKeys: ["railwayIntegrationStatus"] })
		setSyncBusy(false)
		if (Exit.isFailure(result)) {
			// Non-admins are refused; the reason says so instead of a bare failure.
			toastManager.add({
				title: "Failed to sync Railway",
				description: errorMessage(result, "Try again in a moment."),
				type: "error",
			})
		}
	}

	if (status === null || !status.connected) {
		return (
			<IntegrationEmpty icon={RailwayIcon} accent={RAILWAY_ACCENT} iconClassName="text-foreground">
				<IntegrationEmptyFeatures>
					<IntegrationEmptyFeature
						label="Resources"
						title="CPU and memory per replica"
						description="Usage against limits for every service, sampled each minute."
					/>
					<IntegrationEmptyFeature
						label="Network & disk"
						title="Traffic and volumes"
						description="Network in and out, volume and ephemeral disk usage."
					/>
					<IntegrationEmptyFeature
						label="Correlation"
						title="Next to your traces"
						description="Metrics carry the Railway service name, so they line up with your telemetry."
					/>
				</IntegrationEmptyFeatures>
				<IntegrationEmptyCard>
					<IntegrationEmptyMedia />
					<IntegrationEmptyHint>
						Connecting pulls the last hour of metrics right away, then Maple keeps it fresh every
						5 minutes.
					</IntegrationEmptyHint>
					<RailwayTokenForm mode="connect" />
					<IntegrationEmptyFooter>
						<a
							href={TOKENS_URL}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
						>
							Create a token in Railway <ExternalLinkIcon size={12} />
						</a>
						. A workspace token limits Maple to one workspace. PR environments are skipped.
					</IntegrationEmptyFooter>
				</IntegrationEmptyCard>
			</IntegrationEmpty>
		)
	}

	const failing = status.environments.filter((environment) => environment.lastError !== null).length

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4">
				<IntegrationIconPlate
					icon={RailwayIcon}
					accent={RAILWAY_ACCENT}
					iconClassName="text-foreground"
				/>
				<div className="flex flex-1 flex-col gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="text-sm font-semibold">Railway</h3>
						{status.authFailed ? (
							<Badge variant="error">Token rejected</Badge>
						) : failing > 0 ? (
							<Badge variant="warning">Needs attention</Badge>
						) : (
							<Badge variant="success">Connected</Badge>
						)}
					</div>
					<p className="text-xs text-muted-foreground">
						{status.workspaceNames ? `${status.workspaceNames} · ` : ""}
						{plural(status.environments.length, "environment")}
						{status.lastSyncedAt !== null
							? ` · synced ${formatRelativeTime(new Date(status.lastSyncedAt).toISOString())}`
							: ""}
						{queued > 0 ? ` · ${queued} waiting for their first sync` : ""}
					</p>
					{status.authFailed ? (
						<p className="text-xs text-severity-error" role="alert">
							Railway rejected the saved token, so polling is paused. Paste a new token to
							resume.
						</p>
					) : status.lastError !== null ? (
						<p className="text-xs text-muted-foreground">Last error: {status.lastError}</p>
					) : null}
					{rotating || status.authFailed ? (
						<RailwayTokenForm
							mode="rotate"
							onSaved={() => setRotating(false)}
							onCancel={status.authFailed ? undefined : () => setRotating(false)}
						/>
					) : (
						<div className="flex flex-wrap gap-2">
							<Button size="sm" render={<Link to="/infra/railway">View metrics</Link>} />
							<Button size="sm" variant="outline" onClick={handleSync} disabled={syncBusy}>
								{syncBusy ? <LoaderIcon size={14} className="animate-spin" /> : null}
								Sync now
							</Button>
							<Button size="sm" variant="outline" onClick={() => setRotating(true)}>
								Replace token
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={handleDisconnect}
								disabled={disconnectBusy}
							>
								{disconnectBusy ? <LoaderIcon size={14} className="animate-spin" /> : null}
								Disconnect
							</Button>
						</div>
					)}
				</div>
			</div>

			<div className="overflow-hidden rounded-lg border border-border/60 bg-card">
				<div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-border/60 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
					<span>Environment</span>
					<span className="w-20 text-right">Services</span>
					<span className="w-32 text-right">Last sync</span>
				</div>
				{status.environments.length === 0 ? (
					<p className="px-4 py-6 text-center text-xs text-muted-foreground">
						This token can't see any projects yet.
					</p>
				) : (
					status.environments.map((environment) => (
						<div
							key={environment.environmentId}
							className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-border/60 px-4 py-2.5 text-sm last:border-b-0"
						>
							<span className="flex min-w-0 flex-col">
								<span className="truncate">
									{environment.projectName}
									<span className="text-muted-foreground">
										{" "}
										/ {environment.environmentName}
									</span>
								</span>
								{environment.lastError !== null ? (
									<span className="truncate text-xs text-severity-error">
										{environment.lastError}
									</span>
								) : null}
							</span>
							<span className="w-20 text-right tabular-nums text-muted-foreground">
								{environment.serviceCount}
							</span>
							<span className="w-32 text-right text-xs text-muted-foreground">
								{environment.lastSyncedAt !== null ? (
									formatRelativeTime(new Date(environment.lastSyncedAt).toISOString())
								) : environment.lastError !== null ? (
									"Failed"
								) : (
									<span className="inline-flex items-center gap-1">
										<LoaderIcon size={12} className="animate-spin" />
										Syncing
									</span>
								)}
							</span>
						</div>
					))
				)}
			</div>
		</div>
	)
}
