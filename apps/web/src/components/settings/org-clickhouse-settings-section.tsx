import { TONE_FILL, TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { trySync } from "@maple/ui/lib/try-sync"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useEffect, useRef, useState } from "react"
import { Exit, Option } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"
import { Field, FieldLabel, FieldDescription } from "@maple/ui/components/ui/field"
import { Panel } from "@maple/ui/components/ui/panel"
import { RefreshButton } from "@maple/ui/components/ui/refresh-button"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useAsyncAction } from "@/hooks/use-mutation-action"

import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { TruncatedId } from "@maple/ui/components/ui/truncated-id"
import {
	AlertWarningIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleWarningIcon,
	CircleXmarkIcon,
} from "@/components/icons"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import {
	type ClickHouseTableDiffEntry,
	type OrgClickHouseApplySchemaStatus,
	type OrgClickHouseSchemaDiffResponse,
	type OrgClickHouseSettingsResponse,
	OrgClickHouseSettingsUpsertRequest,
} from "@maple/domain/http"
import { DataPlatformUsageSection } from "@/components/settings/data-platform-usage-section"
import { toastExit } from "@/lib/error-toast"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { UnsavedChangesGuard } from "@/components/settings/settings-save-bar"
import { useSettingsDraft } from "@/components/settings/settings-draft"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { RelativeTime } from "@/components/common/relative-time"
import { ErrorState } from "@/components/common/error-state"
import {
	columnDriftResolvedByApply,
	schemaApplyPlan,
	type SchemaDiffStatus,
	schemaDiffCounts,
} from "@/components/settings/schema-apply-plan"

interface OrgClickHouseSettingsSectionProps {
	isAdmin: boolean
	hasEntitlement: boolean
}

export function OrgClickHouseSettingsSection({ isAdmin, hasEntitlement }: OrgClickHouseSettingsSectionProps) {
	if (!isAdmin || !hasEntitlement) return null
	return <DataPlatform />
}

function DataPlatform() {
	const settingsQueryAtom = retainedInternalQuery("orgClickHouseSettings", "get", {})
	const settingsResult = useAtomValue(settingsQueryAtom)
	const refreshSettings = useAtomRefresh(settingsQueryAtom)

	const diffQueryAtom = retainedInternalQuery("orgClickHouseSettings", "schemaDiff", {})
	const refreshDiff = useAtomRefresh(diffQueryAtom)

	const settings = Result.isSuccess(settingsResult) ? settingsResult.value : null

	return (
		<SettingsSections>
			<SettingsSection
				title="Connection"
				description="Read queries for this organization run against your own ClickHouse server."
				framed={false}
			>
				{Result.isFailure(settingsResult) ? (
					<ErrorState error={settingsResult.cause} title="Failed to load the connection" />
				) : settings === null ? (
					<Skeleton className="h-72 w-full rounded-md" />
				) : (
					<ConnectionPanel
						settings={settings}
						onChanged={() => {
							refreshSettings()
							refreshDiff()
						}}
					/>
				)}
			</SettingsSection>
			{settings?.configured === true && (
				<SchemaSection settings={settings} onApplied={refreshSettings} />
			)}
			<DataPlatformUsageSection />
		</SettingsSections>
	)
}

interface ConnectionDraft {
	readonly url: string
	readonly user: string
	readonly database: string
}

const isHttpUrl = (value: string): boolean => {
	const url = Option.getOrNull(trySync(() => new URL(value.trim())))
	return url !== null && (url.protocol === "https:" || url.protocol === "http:")
}

function ConnectionStatus({ settings }: { settings: OrgClickHouseSettingsResponse }) {
	if (!settings.configured) {
		return (
			<div className="flex items-center gap-2 border-b px-4 py-3 text-xs">
				<span className={cn("size-1.5 rounded-full", TONE_FILL.neutral)} />
				<span>Not connected</span>
				<span className="text-muted-foreground">· Queries use Maple&apos;s warehouse</span>
			</div>
		)
	}
	const failing = settings.syncStatus === "error"
	return (
		<div className="flex flex-col gap-1 border-b px-4 py-3 text-xs">
			<div className="flex items-center gap-2">
				<span className={cn("size-1.5 rounded-full", failing ? TONE_FILL.crit : TONE_FILL.ok)} />
				<span>{failing ? "Connection error" : "Connected"}</span>
				{settings.lastSyncAt !== null && (
					<span className="text-muted-foreground">
						· last checked <RelativeTime value={settings.lastSyncAt} />
					</span>
				)}
			</div>
			{failing && settings.lastSyncError !== null && (
				<p className={cn("break-words pl-3.5", TONE_TEXT.crit)}>{settings.lastSyncError}</p>
			)}
		</div>
	)
}

function ConnectionPanel({
	settings,
	onChanged,
}: {
	settings: OrgClickHouseSettingsResponse
	onChanged: () => void
}) {
	const saved: ConnectionDraft = {
		url: settings.chUrl ?? "",
		user: settings.chUser ?? "default",
		database: settings.chDatabase ?? "default",
	}
	const { draft, isDirty, updateDraft, discard, commit, submit, abort } = useSettingsDraft(saved)
	const [password, setPassword] = useState("")
	const [disconnectOpen, setDisconnectOpen] = useState(false)
	const dirty = isDirty || password !== ""

	const upsertMutation = useAtomSet(MapleInternalAtomClient.mutation("orgClickHouseSettings", "upsert"), {
		mode: "promiseExit",
	})
	const deleteMutation = useAtomSet(MapleInternalAtomClient.mutation("orgClickHouseSettings", "delete"), {
		mode: "promiseExit",
	})

	const [handleSave, isSaving] = useAsyncAction(async () => {
		const submitted = submit()
		const sent = { url: draft.url.trim(), user: draft.user.trim(), database: draft.database.trim() }
		const result = await upsertMutation({
			payload: new OrgClickHouseSettingsUpsertRequest({
				...sent,
				...(password !== "" ? { password } : undefined),
			}),
		})
		if (!toastExit(result, { success: "Connection saved and tested", error: "Connection test failed" })) {
			abort()
			return
		}
		setPassword("")
		commit({ submitted, sent })
		onChanged()
	})

	const [handleDisconnect, isDisconnecting] = useAsyncAction(async () => {
		const result = await deleteMutation({})
		setDisconnectOpen(false)
		if (!toastExit(result, { success: "Disconnected", error: "Failed to disconnect" })) return
		setPassword("")
		discard()
		onChanged()
	})

	const busy = isSaving || isDisconnecting
	const valid = isHttpUrl(draft.url) && draft.user.trim() !== "" && draft.database.trim() !== ""

	return (
		<Panel className="overflow-hidden">
			<UnsavedChangesGuard when={dirty && !busy} />
			<ConnectionStatus settings={settings} />
			<div className="flex flex-col gap-4 p-4">
				<Field>
					<FieldLabel htmlFor="ch-url">ClickHouse URL</FieldLabel>
					<Input
						id="ch-url"
						placeholder="https://your-clickhouse.example.com:8123"
						value={draft.url}
						onChange={(event) => {
							const url = event.target.value
							updateDraft((current) => ({ ...current, url }))
						}}
						disabled={busy}
					/>
					<FieldDescription>HTTP interface URL (port 8123 by default).</FieldDescription>
				</Field>
				<div className="grid gap-3 sm:grid-cols-2">
					<Field>
						<FieldLabel htmlFor="ch-user">User</FieldLabel>
						<Input
							id="ch-user"
							value={draft.user}
							onChange={(event) => {
								const user = event.target.value
								updateDraft((current) => ({ ...current, user }))
							}}
							disabled={busy}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="ch-database">Database</FieldLabel>
						<Input
							id="ch-database"
							value={draft.database}
							onChange={(event) => {
								const database = event.target.value
								updateDraft((current) => ({ ...current, database }))
							}}
							disabled={busy}
						/>
					</Field>
				</div>
				<Field>
					<FieldLabel htmlFor="ch-password">Password</FieldLabel>
					<Input
						id="ch-password"
						type="password"
						placeholder={
							settings.configured ? "Leave blank to keep the current password" : "Optional"
						}
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						disabled={busy}
					/>
				</Field>
			</div>
			<div className="bg-muted/30 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-4 py-3">
				{settings.configured ? (
					<Button
						variant="ghost"
						size="sm"
						className="text-destructive-foreground"
						onClick={() => setDisconnectOpen(true)}
						disabled={busy}
					>
						Disconnect
					</Button>
				) : (
					<span />
				)}
				<div className="flex items-center gap-3">
					<span className="text-muted-foreground text-xs">Saving runs a test query first.</span>
					<Button
						size="sm"
						onClick={() => void handleSave()}
						loading={isSaving}
						disabled={busy || !valid}
					>
						Save and test
					</Button>
				</div>
			</div>
			<ConfirmDialog
				open={disconnectOpen}
				onOpenChange={setDisconnectOpen}
				title="Disconnect your ClickHouse?"
				description="This organization goes back to Maple's managed warehouse. Tables on your cluster are not touched: disconnecting only removes Maple's pointer to it."
				confirmLabel="Disconnect"
				onConfirm={() => void handleDisconnect()}
				pending={isDisconnecting}
			/>
		</Panel>
	)
}

const STATUS_COUNTS: ReadonlyArray<{ status: SchemaDiffStatus; label: string; tone: string }> = [
	{ status: "up_to_date", label: "Up to date", tone: "text-foreground" },
	{ status: "missing", label: "Missing", tone: TONE_TEXT.crit },
	{ status: "drifted", label: "Drifted", tone: TONE_TEXT.warn },
	{ status: "wrong_kind", label: "Wrong kind", tone: TONE_TEXT.warn },
]

const kindLabel = (kind: ClickHouseTableDiffEntry["kind"]) =>
	kind === "materialized_view" ? "view" : "table"

function SchemaSection({
	settings,
	onApplied,
}: {
	settings: OrgClickHouseSettingsResponse
	onApplied: () => void
}) {
	const diffQueryAtom = retainedInternalQuery("orgClickHouseSettings", "schemaDiff", {})
	const diffResult = useAtomValue(diffQueryAtom)
	const refreshDiff = useAtomRefresh(diffQueryAtom)

	const statusQueryAtom = retainedInternalQuery("orgClickHouseSettings", "applySchemaStatus", {})
	const statusResult = useAtomValue(statusQueryAtom)
	const refreshStatus = useAtomRefresh(statusQueryAtom)

	const applyMutation = useAtomSet(
		MapleInternalAtomClient.mutation("orgClickHouseSettings", "applySchema"),
		{
			mode: "promiseExit",
		},
	)
	const [isStarting, setIsStarting] = useState(false)
	const [confirmOpen, setConfirmOpen] = useState(false)
	const { effectiveTimezone } = useTimezonePreference()

	const diff = Result.isSuccess(diffResult) ? diffResult.value : null
	const applyStatus = Result.isSuccess(statusResult) ? statusResult.value : null
	const runActive = applyStatus?.status === "queued" || applyStatus?.status === "running"
	const isApplying = isStarting || runActive

	// Poll the background apply run while it's active. Ticks pause while the tab is hidden, so
	// the terminal-transition toast below fires on refocus rather than in the background.
	useIntervalRefresh(refreshStatus, { intervalMs: 2_000, enabled: runActive })

	// Toast and refresh the diff on terminal transitions (running to succeeded or failed).
	const prevApplyStatusRef = useRef<string | null>(null)
	useEffect(() => {
		const status = applyStatus?.status ?? null
		const prev = prevApplyStatusRef.current
		prevApplyStatusRef.current = status
		if (prev !== "queued" && prev !== "running") return
		if (status === "succeeded") {
			onApplied()
			refreshDiff()
			toastManager.add({ title: "Schema applied", type: "success" })
		} else if (status === "failed") {
			toastManager.add({
				title: "Schema apply failed",
				description: applyStatus?.errorMessage ?? undefined,
				type: "error",
			})
		}
	}, [applyStatus?.status, applyStatus?.errorMessage, onApplied, refreshDiff])

	async function handleApply() {
		setConfirmOpen(false)
		// Apply runs in a background workflow; kick it off and let the status poll drive progress.
		setIsStarting(true)
		const result = await applyMutation({})
		if (Exit.isSuccess(result)) {
			refreshStatus()
			toastManager.add(
				result.value.status === "already_running"
					? { title: "A schema apply is already in progress", type: "info" }
					: { title: "Schema apply started" },
			)
			// Hand off to the status poll; keep the button busy until it reports active.
			setTimeout(() => setIsStarting(false), 1500)
			return
		}
		setIsStarting(false)
		toastExit(result, { error: "Failed to start schema apply" })
	}

	const plan = diff === null ? null : schemaApplyPlan(diff.entries)
	const behind = diff !== null && diff.appliedSchemaVersion !== diff.expectedSchemaVersion
	const hasWork = plan !== null && (plan.create.length > 0 || plan.addColumns.length > 0 || behind)

	return (
		<SettingsSection
			title="Schema"
			description="Your cluster compared with the schema Maple expects."
			padded={false}
			actions={
				<RefreshButton
					variant="outline"
					size="sm"
					label="Refresh diff"
					onRefresh={() => refreshDiff()}
					pending={Result.isSuccess(diffResult) && diffResult.waiting}
					disabled={isApplying}
				/>
			}
		>
			{Result.isFailure(diffResult) ? (
				<ErrorState
					error={diffResult.cause}
					title="Couldn't read your cluster's schema. Check that the connection works."
					variant="inline"
					className="m-4"
				/>
			) : diff === null ? (
				<SkeletonList rows={3} rowClassName="h-9" gap="2" className="p-4" />
			) : (
				<SchemaDiff diff={diff} />
			)}
			<ApplyRunStatus status={applyStatus} />
			<div className="bg-muted/30 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-4 py-3">
				<span className="text-muted-foreground text-xs">
					{settings.schemaVersion !== null && settings.lastSyncAt !== null ? (
						<>
							Last applied version{" "}
							<TruncatedId value={settings.schemaVersion} kind="sha" length={10} /> on{" "}
							{formatTimestampInTimezone(settings.lastSyncAt, {
								timeZone: effectiveTimezone,
								withYear: true,
							})}
						</>
					) : (
						"Schema never applied"
					)}
				</span>
				<Button
					size="sm"
					onClick={() => setConfirmOpen(true)}
					loading={isApplying}
					disabled={isApplying || !hasWork}
				>
					Review and apply
				</Button>
			</div>
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				tone="default"
				icon={<AlertWarningIcon className="text-severity-warn" size={20} />}
				title="Apply the schema to your cluster?"
				description={
					<>
						This runs DDL against <span className="font-mono">{settings.chDatabase}</span> on your
						cluster. Pending Maple migrations run first and can rebuild Maple&apos;s own views and
						backfill data. The snapshot pass then only adds what is listed below.
					</>
				}
				confirmLabel="Apply schema"
				onConfirm={() => void handleApply()}
				pending={isStarting}
			>
				{plan !== null && <SchemaApplyPlanList plan={plan} />}
			</ConfirmDialog>
		</SettingsSection>
	)
}

function SchemaDiff({ diff }: { diff: OrgClickHouseSchemaDiffResponse }) {
	const [showUpToDate, setShowUpToDate] = useState(false)
	const counts = schemaDiffCounts(diff.entries)
	const needsWork = diff.entries.filter((entry) => entry.status !== "up_to_date")
	const upToDate = diff.entries.filter((entry) => entry.status === "up_to_date")

	return (
		<>
			<dl className="grid grid-cols-2 border-b sm:grid-cols-4">
				{STATUS_COUNTS.map(({ status, label, tone }, index) => (
					<div
						key={status}
						className={cn(
							"flex flex-col gap-1 px-4 py-3",
							index > 0 && "sm:border-l",
							index % 2 === 1 && "border-l",
						)}
					>
						<dt className="text-muted-foreground text-2xs font-medium">{label}</dt>
						<dd
							className={cn(
								"font-mono text-xl font-semibold",
								counts[status] === 0 ? "text-muted-foreground" : tone,
							)}
						>
							{counts[status]}
						</dd>
					</div>
				))}
			</dl>
			{needsWork.length === 0 && diff.entries.length > 0 && (
				<p className="text-muted-foreground border-b px-4 py-3 text-xs">
					Every table and view matches what Maple expects.
				</p>
			)}
			{needsWork.map((entry) => (
				<DiffRow key={entry.name} entry={entry} />
			))}
			{upToDate.length > 0 && (
				<>
					<button
						type="button"
						aria-expanded={showUpToDate}
						onClick={() => setShowUpToDate((open) => !open)}
						className="hover:bg-muted/20 flex w-full items-center gap-2 border-b px-3 py-2 text-left text-xs transition-colors"
					>
						<ChevronRightIcon
							size={14}
							className={cn(
								"text-muted-foreground shrink-0 transition-transform",
								showUpToDate && "rotate-90",
							)}
						/>
						<CircleCheckIcon size={14} className={cn("shrink-0", TONE_TEXT.info)} />
						<span className="text-muted-foreground">
							{showUpToDate ? "Hide" : "Show"} up-to-date tables and views ({upToDate.length})
						</span>
					</button>
					{showUpToDate && (
						<ul className="divide-y border-b">
							{upToDate.map((entry) => (
								<li
									key={entry.name}
									className="flex items-center gap-2 py-1.5 pr-3 pl-11 text-xs"
								>
									<span className="font-mono">{entry.name}</span>
									<span className="text-muted-foreground">{kindLabel(entry.kind)}</span>
								</li>
							))}
						</ul>
					)}
				</>
			)}
		</>
	)
}

function entrySummary(entry: ClickHouseTableDiffEntry): { text: string; tone: string } {
	switch (entry.status) {
		case "missing":
			return { text: "Missing, created on apply", tone: TONE_TEXT.crit }
		case "wrong_kind":
			return { text: `Exists as a ${kindLabel(entry.actualKind)}, fix manually`, tone: TONE_TEXT.warn }
		case "drifted":
			return {
				text: `Drifted, ${entry.columnDrifts.length} ${entry.columnDrifts.length === 1 ? "column" : "columns"}`,
				tone: TONE_TEXT.warn,
			}
		case "up_to_date":
			return { text: "Up to date", tone: "text-muted-foreground" }
	}
}

const DRIFT_LABEL = {
	missing: "Missing column",
	extra: "Extra column",
	type_mismatch: "Type mismatch",
} as const

function DiffRow({ entry }: { entry: ClickHouseTableDiffEntry }) {
	const [expanded, setExpanded] = useState(true)
	const summary = entrySummary(entry)
	const Icon = entry.status === "missing" ? CircleXmarkIcon : CircleWarningIcon
	const head = (
		<>
			<Icon size={14} className={cn("shrink-0", summary.tone)} />
			<span className="truncate font-mono">{entry.name}</span>
			<span className="text-muted-foreground">{kindLabel(entry.kind)}</span>
			<span className={cn("ml-auto shrink-0", summary.tone)}>{summary.text}</span>
		</>
	)

	if (entry.status !== "drifted") {
		return <div className="flex items-center gap-2 border-b py-2 pr-3 pl-8.5 text-xs">{head}</div>
	}
	return (
		<div className="border-b">
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded((open) => !open)}
				className="hover:bg-muted/20 flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors"
			>
				<ChevronRightIcon
					size={14}
					className={cn(
						"text-muted-foreground shrink-0 transition-transform",
						expanded && "rotate-90",
					)}
				/>
				{head}
			</button>
			{expanded && (
				<ul className="bg-background mx-3 mb-3 divide-y overflow-hidden rounded-md border">
					{entry.columnDrifts.map((drift) => {
						const resolved = columnDriftResolvedByApply(entry.kind, drift)
						return (
							<li
								key={`${drift.kind}:${drift.column}`}
								className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs"
							>
								<span className="text-muted-foreground w-28 shrink-0">
									{DRIFT_LABEL[drift.kind]}
								</span>
								<span className="min-w-0 font-mono break-all">
									{drift.kind === "missing"
										? `${drift.column} ${drift.expectedType}`
										: drift.kind === "extra"
											? `${drift.column} ${drift.actualType}`
											: `${drift.column} ${drift.actualType} vs ${drift.expectedType}`}
								</span>
								<span
									className={cn(
										"ml-auto shrink-0",
										resolved ? "text-muted-foreground" : TONE_TEXT.warn,
									)}
								>
									{resolved ? "Added on apply" : "Fix manually"}
								</span>
							</li>
						)
					})}
				</ul>
			)}
		</div>
	)
}

/** Progress of a running apply, why the last one failed, and what it skipped. */
function ApplyRunStatus({ status }: { status: OrgClickHouseApplySchemaStatus | null }) {
	if (status === null) return null
	const running = status.status === "queued" || status.status === "running"
	const steps =
		status.stepsTotal !== null && status.stepsDone !== null
			? ` (${status.stepsDone}/${status.stepsTotal})`
			: ""
	return (
		<>
			{running && (
				<p className="text-muted-foreground border-b px-4 py-3 text-xs">
					{status.phase ?? "Applying schema"}
					{steps}
					{status.currentMigration !== null ? ` · migration ${status.currentMigration}` : ""}. Runs
					in the background, safe to leave this page.
				</p>
			)}
			{status.status === "failed" && status.errorMessage !== null && (
				<p className={cn("border-b px-4 py-3 text-xs break-words", TONE_TEXT.crit)}>
					Last apply failed: {status.errorMessage}
				</p>
			)}
			{!running && status.skipped.length > 0 && (
				<div className="flex flex-col gap-1.5 border-b px-4 py-3 text-xs">
					<p className={TONE_TEXT.warn}>
						The last apply skipped{" "}
						{status.skipped.length === 1 ? "one step" : `${status.skipped.length} steps`}. Apply
						again once the cause is fixed.
					</p>
					<ul className="flex flex-col gap-1">
						{status.skipped.map((item) => (
							<li key={item.id} className="text-muted-foreground">
								<span className="text-foreground font-mono">{item.id}</span>: {item.reason}
							</li>
						))}
					</ul>
				</div>
			)}
		</>
	)
}

function SchemaApplyPlanList({ plan }: { plan: ReturnType<typeof schemaApplyPlan> }) {
	const groups = [
		{ label: "Create", items: plan.create },
		{
			label: "Add columns",
			items: plan.addColumns.map((table) => `${table.name}: ${table.columns.join(", ")}`),
		},
		{
			label: "Not resolved by apply (fix manually)",
			items: plan.unresolved.map((entry) => `${entry.name}: ${entry.reason}`),
		},
	].filter((group) => group.items.length > 0)

	if (groups.length === 0) {
		return (
			<p className="text-muted-foreground text-xs">
				No tables or columns to add; only pending migrations run.
			</p>
		)
	}
	return (
		<div className="max-h-56 space-y-3 overflow-y-auto text-xs">
			{groups.map((group) => (
				<div key={group.label} className="space-y-1">
					<p className="text-muted-foreground">
						{group.label} ({group.items.length})
					</p>
					<ul className="space-y-0.5 font-mono">
						{group.items.map((item) => (
							<li key={item} className="break-all">
								{item}
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	)
}
