import { countLabel, EMPTY_VALUE } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useEffect, useMemo, useRef, useState } from "react"
import { Exit } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"
import { Field, FieldLabel, FieldDescription } from "@maple/ui/components/ui/field"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { Panel } from "@maple/ui/components/ui/panel"
import { RefreshButton } from "@maple/ui/components/ui/refresh-button"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useAsyncAction } from "@/hooks/use-mutation-action"

import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"
import { Input } from "@maple/ui/components/ui/input"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { TruncatedId } from "@maple/ui/components/ui/truncated-id"
import {
	AlertWarningIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleWarningIcon,
	CircleXmarkIcon,
} from "@/components/icons"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import { OrgClickHouseSettingsUpsertRequest } from "@maple/domain/http"
import { DataPlatformUsageSection } from "@/components/settings/data-platform-usage-section"
import { toastExit } from "@/lib/error-toast"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { ErrorState } from "@/components/common/error-state"

interface OrgClickHouseSettingsSectionProps {
	isAdmin: boolean
	hasEntitlement: boolean
}

export function OrgClickHouseSettingsSection({ isAdmin, hasEntitlement }: OrgClickHouseSettingsSectionProps) {
	const [chUrl, setChUrl] = useState("")
	const [chUser, setChUser] = useState("default")
	const [chPassword, setChPassword] = useState("")
	const [chDatabase, setChDatabase] = useState("default")
	const [isStarting, setIsStarting] = useState(false)
	const [disableOpen, setDisableOpen] = useState(false)
	const { effectiveTimezone } = useTimezonePreference()
	const [expandedDrifts, setExpandedDrifts] = useState<ReadonlySet<string>>(new Set())

	const settingsQueryAtom = retainedInternalQuery("orgClickHouseSettings", "get", {})
	const settingsResult = useAtomValue(settingsQueryAtom)
	const refreshSettings = useAtomRefresh(settingsQueryAtom)

	const diffQueryAtom = retainedInternalQuery("orgClickHouseSettings", "schemaDiff", {})
	const diffResult = useAtomValue(diffQueryAtom)
	const refreshDiff = useAtomRefresh(diffQueryAtom)

	const statusQueryAtom = retainedInternalQuery("orgClickHouseSettings", "applySchemaStatus", {})
	const statusResult = useAtomValue(statusQueryAtom)
	const refreshStatus = useAtomRefresh(statusQueryAtom)

	const upsertMutation = useAtomSet(MapleInternalAtomClient.mutation("orgClickHouseSettings", "upsert"), {
		mode: "promiseExit",
	})
	const applyMutation = useAtomSet(
		MapleInternalAtomClient.mutation("orgClickHouseSettings", "applySchema"),
		{
			mode: "promiseExit",
		},
	)
	const deleteMutation = useAtomSet(MapleInternalAtomClient.mutation("orgClickHouseSettings", "delete"), {
		mode: "promiseExit",
	})

	const [handleSave, isSaving] = useAsyncAction(async () => {
		const result = await upsertMutation({
			payload: new OrgClickHouseSettingsUpsertRequest({
				url: chUrl,
				user: chUser,
				password: chPassword,
				database: chDatabase,
			}),
		})

		if (!toastExit(result, { success: "ClickHouse connection saved", error: "Failed to save settings" }))
			return
		setChPassword("")
		refreshSettings()
		refreshDiff()
	})

	const [handleRefreshDiff, isRefreshingDiff] = useAsyncAction(async () => {
		refreshDiff()
		// Atom refresh is fire-and-forget; tiny delay so the spinner is visible on
		// fast re-runs and we don't end the busy state before the new request lands.
		await new Promise((resolve) => setTimeout(resolve, 300))
	})

	const [handleDisable, isDisabling] = useAsyncAction(async () => {
		const result = await deleteMutation({})
		setDisableOpen(false)

		if (
			!toastExit(result, {
				success: "BYO ClickHouse disabled",
				error: "Failed to disable BYO ClickHouse",
			})
		)
			return
		setChUrl("")
		setChPassword("")
		refreshSettings()
		refreshDiff()
	})

	const settings = Result.builder(settingsResult)
		.onSuccess((value) => value)
		.orElse(() => null)

	const diff = Result.builder(diffResult)
		.onSuccess((value) => value)
		.orElse(() => null)

	const applyStatus = Result.builder(statusResult)
		.onSuccess((value) => value)
		.orElse(() => null)

	const runActive = applyStatus?.status === "queued" || applyStatus?.status === "running"
	const isApplying = isStarting || runActive
	const configured = settings?.configured === true
	const isBusy = isSaving || isApplying || isRefreshingDiff || isDisabling

	// Poll the background apply run while it's active. Ticks pause while the tab is
	// hidden, so the terminal-transition toast below fires on refocus rather than
	// in the background — this is a foreground progress indicator.
	useIntervalRefresh(refreshStatus, { intervalMs: 2_000, enabled: runActive })

	// Toast + refresh the diff on terminal transitions (running → succeeded/failed).
	const prevApplyStatusRef = useRef<string | null>(null)
	useEffect(() => {
		const status = applyStatus?.status ?? null
		const prev = prevApplyStatusRef.current
		prevApplyStatusRef.current = status
		if (prev !== "queued" && prev !== "running") return
		if (status === "succeeded") {
			refreshSettings()
			refreshDiff()
			toastManager.add({ title: "Schema applied", type: "success" })
		} else if (status === "failed") {
			toastManager.add({
				title: "Schema apply failed",
				description: applyStatus?.errorMessage ?? undefined,
				type: "error",
			})
		}
	}, [applyStatus?.status, applyStatus?.errorMessage, refreshSettings, refreshDiff])

	useEffect(() => {
		if (settings?.chUrl != null) setChUrl(settings.chUrl)
		if (settings?.chUser != null) setChUser(settings.chUser)
		if (settings?.chDatabase != null) setChDatabase(settings.chDatabase)
	}, [settings?.chUrl, settings?.chUser, settings?.chDatabase])

	const isValidUrl = useMemo(() => {
		const trimmed = chUrl.trim()
		if (trimmed.length === 0) return false
		try {
			const url = new URL(trimmed)
			return url.protocol === "https:" || url.protocol === "http:"
		} catch {
			return false
		}
	}, [chUrl])

	const statusBadge = useMemo(() => {
		if (!configured) return <Badge variant="secondary">Default Maple Tinybird</Badge>
		if (settings?.syncStatus === "error") return <Badge variant="crit">Needs attention</Badge>
		return <Badge variant="outline">Connected</Badge>
	}, [configured, settings?.syncStatus])

	const diffSummary = useMemo(() => {
		if (!diff) return null
		const counts = { up_to_date: 0, missing: 0, drifted: 0, wrong_kind: 0 }
		for (const entry of diff.entries) counts[entry.status]++
		return counts
	}, [diff])

	async function handleApply() {
		// Apply now runs in a background workflow (heavy backfill migrations can't
		// fit one request). Kick it off, then the status poll drives progress.
		setIsStarting(true)
		const result = await applyMutation({})

		if (Exit.isSuccess(result)) {
			refreshStatus()
			if (result.value.status === "already_running") {
				toastManager.add({ title: "A schema apply is already in progress", type: "info" })
			} else {
				toastManager.add({ title: "Schema apply started" })
			}
			// Hand off to the status poll; keep the button busy until it reports active.
			setTimeout(() => setIsStarting(false), 1500)
			return
		}
		setIsStarting(false)
		toastExit(result, { error: "Failed to start schema apply" })
	}

	function toggleDriftRow(name: string) {
		setExpandedDrifts((prev) => {
			const next = new Set(prev)
			if (next.has(name)) next.delete(name)
			else next.add(name)
			return next
		})
	}

	if (!isAdmin || !hasEntitlement) return null

	return (
		<>
			<SettingsSections>
				<DataPlatformUsageSection />
				<SettingsSection
					title="Bring your own ClickHouse"
					description="Route this organization's read queries through your own ClickHouse server. Save the connection first, then review the schema diff and apply the bundled snapshot to your cluster."
					actions={
						Result.isInitial(settingsResult) ? <Skeleton className="h-6 w-36" /> : statusBadge
					}
				>
					<div className="space-y-5">
						{Result.isFailure(settingsResult) ? (
							<ErrorState
								error={settingsResult.cause}
								title="Failed to load settings"
								variant="inline"
							/>
						) : (
							<>
								<Field>
									<FieldLabel htmlFor="ch-url">ClickHouse URL</FieldLabel>
									<Input
										id="ch-url"
										placeholder="https://your-clickhouse.example.com:8123"
										value={chUrl}
										onChange={(event) => setChUrl(event.target.value)}
										disabled={isBusy}
									/>
									<FieldDescription>
										HTTP interface URL (port 8123 by default).
									</FieldDescription>
								</Field>

								<div className="grid gap-2 sm:grid-cols-2">
									<Field>
										<FieldLabel htmlFor="ch-user">User</FieldLabel>
										<Input
											id="ch-user"
											value={chUser}
											onChange={(event) => setChUser(event.target.value)}
											disabled={isBusy}
										/>
									</Field>
									<Field>
										<FieldLabel htmlFor="ch-database">Database</FieldLabel>
										<Input
											id="ch-database"
											value={chDatabase}
											onChange={(event) => setChDatabase(event.target.value)}
											disabled={isBusy}
										/>
									</Field>
								</div>

								<Field>
									<FieldLabel htmlFor="ch-password">Password</FieldLabel>
									<Input
										id="ch-password"
										type="password"
										placeholder={
											configured
												? "Leave blank to keep the current password"
												: "Optional"
										}
										value={chPassword}
										onChange={(event) => setChPassword(event.target.value)}
										disabled={isBusy}
									/>
									<FieldDescription>
										Leave blank for unauthenticated CH instances or to keep the existing
										password.
									</FieldDescription>
								</Field>

								<div className="flex flex-wrap gap-2">
									<Button
										onClick={() => void handleSave()}
										loading={isSaving}
										disabled={
											isBusy ||
											!isValidUrl ||
											chUser.trim().length === 0 ||
											chDatabase.trim().length === 0
										}
									>
										{configured ? "Update connection" : "Save connection"}
									</Button>
									<Button
										variant="destructive"
										onClick={() => setDisableOpen(true)}
										disabled={isBusy || !configured}
									>
										Disable BYO
									</Button>
								</div>
							</>
						)}
					</div>
				</SettingsSection>

				{configured ? (
					<SettingsSection
						title="Schema"
						description="Compare your cluster against Maple's bundled schema snapshot. Apply creates missing tables and views, and adds missing columns to existing tables. Type mismatches are skipped: resolve those manually."
					>
						<div className="space-y-4">
							<Panel padded="sm" tone="muted">
								<KeyValueList layout="stacked" className="grid-cols-2 sm:grid-cols-4">
									<KeyValue label="Last applied">
										{settings?.lastSyncAt
											? formatTimestampInTimezone(settings.lastSyncAt, {
													timeZone: effectiveTimezone,
													withYear: true,
												})
											: "Never"}
									</KeyValue>
									<KeyValue label="Applied version" mono>
										{settings?.schemaVersion ? (
											<TruncatedId
												value={settings.schemaVersion}
												kind="sha"
												length={10}
											/>
										) : (
											EMPTY_VALUE
										)}
									</KeyValue>
									<KeyValue label="Expected version" mono>
										{diff?.expectedSchemaVersion ? (
											<TruncatedId
												value={diff.expectedSchemaVersion}
												kind="sha"
												length={10}
											/>
										) : (
											EMPTY_VALUE
										)}
									</KeyValue>
									<KeyValue label="Drift">
										{diffSummary
											? `${diffSummary.up_to_date} ok · ${diffSummary.missing} missing · ${diffSummary.drifted} drift`
											: EMPTY_VALUE}
									</KeyValue>
								</KeyValueList>
							</Panel>

							{Result.isInitial(diffResult) ? (
								<SkeletonList rows={3} rowClassName="h-9" gap="2" />
							) : Result.isFailure(diffResult) ? (
								<ErrorState
									error={diffResult.cause}
									title="Failed to introspect ClickHouse. Check that the credentials are valid."
									variant="inline"
								/>
							) : diff && diff.entries.length > 0 ? (
								<Panel className="divide-y">
									{diff.entries.map((entry) => {
										const isExpanded = expandedDrifts.has(entry.name)
										const isDrifted = entry.status === "drifted"
										return (
											<div key={entry.name} className="px-3 py-2 text-sm">
												<button
													type="button"
													className={
														"flex w-full items-center gap-2 text-left " +
														(isDrifted ? "cursor-pointer" : "cursor-default")
													}
													onClick={() => isDrifted && toggleDriftRow(entry.name)}
												>
													{entry.status === "up_to_date" ? (
														<CircleCheckIcon
															size={14}
															className="text-severity-info shrink-0"
														/>
													) : entry.status === "missing" ? (
														<CircleXmarkIcon
															size={14}
															className="text-severity-error shrink-0"
														/>
													) : (
														<CircleWarningIcon
															size={14}
															className="text-severity-warn shrink-0"
														/>
													)}
													<span className="font-mono text-xs">{entry.name}</span>
													<span className="text-muted-foreground text-xs">
														{entry.kind === "materialized_view" ? "MV" : "table"}
													</span>
													<span className="ml-auto text-xs">
														{entry.status === "up_to_date"
															? "Up to date"
															: entry.status === "missing"
																? "Missing, will be created"
																: entry.status === "wrong_kind"
																	? `Wrong kind: expected ${entry.kind === "materialized_view" ? "MV" : "table"}, found ${entry.actualKind === "materialized_view" ? "MV" : "table"}; resolve manually`
																	: `Drift: ${countLabel(entry.columnDrifts.length, "mismatch", "mismatches")}`}
													</span>
													{isDrifted ? (
														isExpanded ? (
															<ChevronDownIcon size={12} />
														) : (
															<ChevronRightIcon size={12} />
														)
													) : null}
												</button>
												{isDrifted && isExpanded ? (
													<ul className="mt-2 ml-6 space-y-1 font-mono text-xs">
														{entry.columnDrifts.map((drift) => (
															<li
																key={`${entry.name}-${drift.column}`}
																className="text-muted-foreground"
															>
																{drift.kind === "missing"
																	? `– missing column \`${drift.column}\` (expected ${drift.expectedType})`
																	: drift.kind === "extra"
																		? `– extra column \`${drift.column}\` (${drift.actualType})`
																		: `– type mismatch on \`${drift.column}\`: expected ${drift.expectedType}, got ${drift.actualType}`}
															</li>
														))}
													</ul>
												) : null}
											</div>
										)
									})}
								</Panel>
							) : (
								<EmptyMessage dashed>No tables in the schema.</EmptyMessage>
							)}

							<div className="flex flex-wrap gap-2">
								<RefreshButton
									size="default"
									label="Refresh diff"
									onRefresh={() => void handleRefreshDiff()}
									pending={isRefreshingDiff}
									disabled={isBusy}
								/>
								<Button
									onClick={() => void handleApply()}
									loading={isApplying}
									disabled={
										isBusy ||
										!diff ||
										(diffSummary?.missing === 0 && diffSummary?.drifted === 0)
									}
								>
									{diffSummary && diffSummary.missing > 0
										? `Apply schema (${diffSummary.missing} missing${diffSummary.drifted > 0 ? `, ${diffSummary.drifted} skipped` : ""})`
										: "Apply schema"}
								</Button>
							</div>
							{runActive && (
								<p className="text-sm text-muted-foreground">
									{applyStatus?.phase ?? "Applying schema…"}
									{applyStatus?.stepsTotal != null && applyStatus?.stepsDone != null
										? ` (${applyStatus.stepsDone}/${applyStatus.stepsTotal})`
										: ""}
									{applyStatus?.currentMigration != null
										? ` · migration ${applyStatus.currentMigration}`
										: ""}
									{". Runs in the background, safe to leave this page."}
								</p>
							)}
							{applyStatus?.status === "failed" && applyStatus.errorMessage && (
								<p className={cn("text-sm", TONE_TEXT.crit)}>{applyStatus.errorMessage}</p>
							)}
						</div>
					</SettingsSection>
				) : null}
			</SettingsSections>

			<ConfirmDialog
				open={disableOpen}
				onOpenChange={setDisableOpen}
				tone="default"
				icon={<AlertWarningIcon className="text-severity-warn" size={20} />}
				title="Disable BYO ClickHouse?"
				description={
					<>
						This org will fall back to the default Maple-managed Tinybird Cloud. Tables in your
						ClickHouse cluster are NOT touched: disable just removes Maple&apos;s pointer to it.
					</>
				}
				confirmLabel="Disable"
				onConfirm={() => void handleDisable()}
				pending={isDisabling}
			/>
		</>
	)
}
