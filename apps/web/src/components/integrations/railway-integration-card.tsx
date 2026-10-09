import { Spinner } from "@maple/ui/components/ui/spinner"
import { useState } from "react"
import { Exit, Option, Schema } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { Link } from "@tanstack/react-router"
import { RailwayConnectRequest, type RailwayIntegrationStatus } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Item, ItemContent, ItemMedia } from "@maple/ui/components/ui/item"
import { Field, FieldDescription, FieldError, FieldLabel } from "@maple/ui/components/ui/field"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toastManager } from "@maple/ui/components/ui/toast"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { countLabel } from "@maple/ui/lib/format"

import { ColumnHead, DataTable } from "@/components/common/data-table"
import { ErrorState } from "@/components/common/error-state"
import { RelativeTime } from "@/components/common/relative-time"
import { ExternalLinkIcon, RailwayIcon } from "@/components/icons"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { errorMessage, toastExit } from "@/lib/error-toast"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
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
import { useIntegrationDisconnect } from "./use-integration-disconnect"

const TOKENS_URL = "https://railway.com/account/tokens"

const decodeConnectRequest = Schema.decodeUnknownOption(RailwayConnectRequest)

export const railwayStatusAtom = retainedInternalQuery("integrations", "railwayStatus", {
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
					? `${countLabel(synced, "environment")} synced, ${failed} failed. The rows below say why.`
					: queued === 0
						? `Pulled the last hour of metrics for ${countLabel(synced, "environment")}.`
						: `${countLabel(synced, "environment")} synced, ${queued} more within 5 minutes.`,
		type: "success" as const,
	}
}

function RailwayTokenForm({
	mode,
	onSaved,
	onCancel,
}: {
	mode: "connect" | "rotate"
	onSaved?: () => void
	onCancel?: () => void
}) {
	const connect = useAtomSet(MapleInternalAtomClient.mutation("integrations", "railwayConnect"), {
		mode: "promiseExit",
	})
	const [token, setToken] = useState("")
	const [error, setError] = useState<string | null>(null)

	// Decoding builds the class instance v1 payloads need (a plain object is never sent) and
	// checks the length rules without the constructor's throw.
	const request = decodeConnectRequest({ token: token.trim() })
	const tokenInvalid = token.trim().length > 0 && Option.isNone(request)

	const [submit, submitting] = useAsyncAction(async () => {
		if (Option.isNone(request)) return
		setError(null)
		const result = await connect({
			payload: request.value,
			reactivityKeys: ["railwayIntegrationStatus"],
		})
		if (Exit.isSuccess(result)) {
			toastManager.add(connectedToast(result.value, mode))
			setToken("")
			onSaved?.()
			return
		}
		// Railway's rejection reason is the actionable part; keep it on screen.
		setError(errorMessage(result, "Failed to connect Railway."))
	})

	function handleSubmit(event: React.FormEvent) {
		event.preventDefault()
		if (Option.isSome(request)) void submit()
	}

	return (
		<form onSubmit={handleSubmit} className="flex w-full flex-col gap-2 text-left">
			<Field className="items-stretch gap-2" invalid={!submitting && error !== null}>
				<FieldLabel htmlFor="railway-token">Account or workspace token</FieldLabel>
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
					<Button type="submit" disabled={Option.isNone(request)} loading={submitting}>
						<RailwayIcon size={14} />
						{mode === "rotate" ? "Update token" : "Connect Railway"}
					</Button>
				</div>
				{submitting ? (
					<p className="text-xs text-muted-foreground" aria-live="polite">
						Checking the token and pulling the last hour of metrics. This takes a few seconds.
					</p>
				) : error !== null ? (
					<FieldError match role="alert">
						{error}
					</FieldError>
				) : tokenInvalid ? (
					<FieldDescription>A Railway token is between 8 and 512 characters.</FieldDescription>
				) : null}
			</Field>
		</form>
	)
}

export function RailwayIntegrationCard() {
	const statusResult = useAtomValue(railwayStatusAtom)
	const refreshStatus = useAtomRefresh(railwayStatusAtom)
	const disconnect = useAtomSet(MapleInternalAtomClient.mutation("integrations", "railwayDisconnect"), {
		mode: "promiseExit",
	})
	const sync = useAtomSet(MapleInternalAtomClient.mutation("integrations", "railwaySync"), {
		mode: "promiseExit",
	})
	const { disconnect: handleDisconnect, pending: disconnectBusy } = useIntegrationDisconnect(
		() => disconnect({ reactivityKeys: ["railwayIntegrationStatus"] }),
		{ success: "Railway disconnected", error: "Failed to disconnect Railway" },
	)
	const [handleSync, syncBusy] = useAsyncAction(async () => {
		const result = await sync({ reactivityKeys: ["railwayIntegrationStatus"] })
		// Non-admins are refused; the reason says so instead of a bare failure.
		toastExit(result, { error: "Failed to sync Railway" })
	})
	const [rotating, setRotating] = useState(false)
	const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)

	// Keep the last loaded status if a refetch fails.
	const status = Option.getOrNull(AsyncResult.value(statusResult))

	const queued = status?.connected && !status.authFailed ? unsyncedEnvironments(status) : 0
	// Poll while environments are still waiting on their first sync so the rows land on their own.
	useIntervalRefresh(refreshStatus, { intervalMs: SETTLING_REFRESH_MS, enabled: queued > 0 })

	if (Result.isInitial(statusResult) && status === null) {
		return <Skeleton className="h-32 w-full rounded-md" />
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
			<Item variant="card" className="items-start gap-4 p-4">
				<ItemMedia>
					<IntegrationIconPlate
						icon={RailwayIcon}
						accent={RAILWAY_ACCENT}
						iconClassName="text-foreground"
					/>
				</ItemMedia>
				<ItemContent className="gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="text-sm font-semibold">Railway</h3>
						{status.authFailed ? (
							<Badge variant="crit">Token rejected</Badge>
						) : failing > 0 ? (
							<Badge variant="warn">Needs attention</Badge>
						) : (
							<Badge variant="ok">Connected</Badge>
						)}
					</div>
					<p className="text-xs text-muted-foreground">
						{status.workspaceNames ? `${status.workspaceNames} · ` : ""}
						{countLabel(status.environments.length, "environment")}
						{status.lastSyncedAt !== null ? (
							<>
								{" · "}
								<RelativeTime value={status.lastSyncedAt} prefix="synced" />
							</>
						) : null}
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
							<Button
								size="sm"
								variant="outline"
								onClick={() => void handleSync()}
								loading={syncBusy}
							>
								Sync now
							</Button>
							<Button size="sm" variant="outline" onClick={() => setRotating(true)}>
								Replace token
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => setConfirmingDisconnect(true)}
								loading={disconnectBusy}
							>
								Disconnect
							</Button>
						</div>
					)}
					<ConfirmDialog
						open={confirmingDisconnect}
						onOpenChange={setConfirmingDisconnect}
						title="Disconnect Railway"
						description="Maple stops collecting metrics from your Railway projects. You can reconnect later."
						confirmLabel="Disconnect"
						onConfirm={() => {
							setConfirmingDisconnect(false)
							void handleDisconnect()
						}}
					/>
				</ItemContent>
			</Item>

			<DataTable.Root ariaLabel="Railway environments">
				<DataTable.Head>
					<ColumnHead label="Environment" width="w-0 min-w-48 flex-1" />
					<ColumnHead label="Services" width="w-20" align="right" />
					<ColumnHead label="Last sync" width="w-32" align="right" />
				</DataTable.Head>
				{status.environments.length === 0 ? (
					<DataTable.Empty>This token can't see any projects yet.</DataTable.Empty>
				) : (
					status.environments.map((environment) => (
						<div
							key={environment.environmentId}
							className="flex items-center gap-4 border-b border-border/40 px-4 py-2.5 text-sm last:border-0"
						>
							<span className="flex w-0 min-w-48 flex-1 flex-col">
								<span className="truncate">
									{environment.projectName}
									<span className="text-muted-foreground">
										{" "}
										/ {environment.environmentName}
									</span>
								</span>
								{environment.lastError !== null ? (
									<TruncatedText className="text-xs text-severity-error">
										{environment.lastError}
									</TruncatedText>
								) : null}
							</span>
							<span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
								{environment.serviceCount}
							</span>
							<span className="w-32 shrink-0 text-right text-xs text-muted-foreground">
								{environment.lastSyncedAt !== null ? (
									<RelativeTime value={environment.lastSyncedAt} tooltip="title" />
								) : environment.lastError !== null ? (
									"Failed"
								) : (
									<span className="inline-flex items-center gap-1">
										<Spinner size={12} />
										Syncing
									</span>
								)}
							</span>
						</div>
					))
				)}
			</DataTable.Root>
		</div>
	)
}
