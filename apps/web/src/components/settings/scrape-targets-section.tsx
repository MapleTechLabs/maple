import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { ScrapeIntervalSeconds } from "@maple/domain/http"
import type { ScrapeAuthType, ScrapeTargetId } from "@maple/domain/http"
import type { V2ScrapeTarget, V2ScrapeTargetCheck } from "@maple/domain/http/v2"
import { useState, type KeyboardEvent } from "react"
import { Exit, Option, Schema } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"
import { Field, FieldLabel, FieldDescription, FieldError } from "@maple/ui/components/ui/field"
import { FormDialog } from "@maple/ui/components/ui/form-dialog"
import { Panel } from "@maple/ui/components/ui/panel"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { trySync } from "@maple/ui/lib/try-sync"
import { StatusDot } from "@maple/ui/components/ui/status-dot"

import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { type ScrapeTargetChecksResponse, useScrapeTargetChecks } from "@/hooks/use-scrape-target-checks"
import { scrapeTargetsListAtom } from "@/lib/services/atoms/scrape-target-atoms"

import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { DropdownMenuItem, DropdownMenuSeparator } from "@maple/ui/components/ui/dropdown-menu"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Switch } from "@maple/ui/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"
import {
	BoltIcon,
	CircleCheckIcon,
	CircleInfoIcon,
	CircleWarningIcon,
	CircleXmarkIcon,
	ExternalLinkIcon,
	FireIcon,
	HistoryIcon,
	PencilIcon,
	PlusIcon,
	PulseIcon,
	TrashIcon,
} from "@/components/icons"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { EMPTY_VALUE, formatDuration, formatNumber } from "@maple/ui/lib/format"
import { RelativeTime } from "@/components/common/relative-time"
import { diagnoseScrapeError } from "@/lib/scrape-error-diagnosis"
import { scheduledStatusFromChecks, scheduledStatusFromRollup } from "@/lib/scrape-target-status"
import { catalogEntry } from "../integrations/integration-catalog"
import { DocsLink } from "@/components/common/docs-link"
import { ErrorState } from "@/components/common/error-state"
import { useAsyncAction, useKeyedAsyncAction } from "@/hooks/use-mutation-action"
import { toastExit } from "@/lib/error-toast"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyFooter,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "../integrations/integration-empty-state"

type ScrapeTarget = V2ScrapeTarget
type ScrapeTargetCheck = V2ScrapeTargetCheck
type ScrapeTargetChecksResult = Result.Result<ScrapeTargetChecksResponse, unknown>

const AUTH_TYPE_LABELS: Record<ScrapeAuthType, string> = {
	none: "None",
	bearer: "Bearer Token",
	basic: "Basic Auth",
	token: "Service Token",
	planetscale_oauth: "PlanetScale OAuth",
} satisfies Record<ScrapeAuthType, string>

const decodeScrapeInterval = Schema.decodeUnknownOption(ScrapeIntervalSeconds)

function formatDurationSeconds(value: number | null): string {
	if (value == null) return EMPTY_VALUE
	return formatDuration(value * 1000)
}

function formatOptionalCount(value: number | null): string {
	if (value == null) return EMPTY_VALUE
	return formatNumber(Math.round(value))
}

/** Created/updated/check times, in the viewer's chosen timezone. */
function useFormatDateTime(): (value: string) => string {
	const { effectiveTimezone } = useTimezonePreference()
	return (value) => formatTimestampInTimezone(value, { timeZone: effectiveTimezone })
}

function hostnameFromUrl(value: string): string {
	return Option.getOrElse(
		trySync(() => new URL(value).host),
		() => value,
	)
}

function labelEntries(labelsJson: string | null): Array<[string, string]> {
	if (!labelsJson) return []
	const parsed = Option.getOrNull(trySync((): Record<string, unknown> => JSON.parse(labelsJson)))
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
	return Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
}

function checksFromResult(result: ScrapeTargetChecksResult): ScrapeTargetCheck[] {
	return Result.builder(result)
		.onSuccess((response) => [...response.checks] as ScrapeTargetCheck[])
		.orElse(() => [])
}

const COPY = {
	description: "Scrape Prometheus exporters and inspect scheduled scrape health.",
	emptyHint: "Targets you add will appear here with per-run scrape health.",
	emptyFooter: "Any Prometheus-compatible endpoint · scraped on your schedule",
	features: [
		{
			label: "Metrics explorer",
			title: "Scraped metrics, ready to chart",
			description: "Scraped metrics land alongside your OTel metrics in the explorer.",
		},
		{
			label: "Dashboards & alerts",
			title: "Widgets and thresholds",
			description: "Build dashboard widgets and threshold alerts on any scraped metric.",
		},
		{
			label: "Scrape health",
			title: "Every run checked",
			description: "Scheduled probes with per-target history and error diagnosis.",
		},
	],
} as const

/**
 * Prometheus scrape-target manager. PlanetScale metrics collection is fully
 * managed by its integration and never surfaces here; this section only
 * lists and edits user-created prometheus targets.
 */
export function ScrapeTargetsSection({
	sourceFilter = "prometheus",
}: {
	sourceFilter?: "prometheus"
} = {}) {
	const [dialogOpen, setDialogOpen] = useState(false)
	const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<ScrapeTarget | null>(null)
	const [selectedTargetId, setSelectedTargetId] = useState<ScrapeTargetId | null>(null)

	const [editingTarget, setEditingTarget] = useState<ScrapeTarget | null>(null)
	const [formName, setFormName] = useState("")
	const [formServiceName, setFormServiceName] = useState("")
	const [formUrl, setFormUrl] = useState("")
	const [formInterval, setFormInterval] = useState("15")
	const [formAuthType, setFormAuthType] = useState<ScrapeAuthType>("none")
	const [formAuthToken, setFormAuthToken] = useState("")
	const [formAuthUsername, setFormAuthUsername] = useState("")
	const [formAuthPassword, setFormAuthPassword] = useState("")

	const listQueryAtom = scrapeTargetsListAtom
	const listResult = useAtomValue(listQueryAtom)
	const refreshTargets = useAtomRefresh(listQueryAtom)
	useIntervalRefresh(refreshTargets, { intervalMs: 30_000, enabled: true })

	const createMutation = useAtomSet(MapleApiV2AtomClient.mutation("scrapeTargets", "create"), {
		mode: "promiseExit",
	})
	const updateMutation = useAtomSet(MapleApiV2AtomClient.mutation("scrapeTargets", "update"), {
		mode: "promiseExit",
	})
	const deleteMutation = useAtomSet(MapleApiV2AtomClient.mutation("scrapeTargets", "delete"), {
		mode: "promiseExit",
	})
	const probeMutation = useAtomSet(MapleApiV2AtomClient.mutation("scrapeTargets", "probe"), {
		mode: "promiseExit",
	})

	const targets = Result.builder(listResult)
		.onSuccess((response) => [...response.data])
		.orElse(() => [] as ScrapeTarget[])
		.filter((target) => target.target_type === sourceFilter)
	const selectedTarget = targets.find((target) => target.id === selectedTargetId) ?? null
	const copy = COPY
	// When empty, the centered empty state owns the primary action, so hide the toolbar row.
	const isEmpty = Result.isSuccess(listResult) && targets.length === 0
	const emptyEntry = catalogEntry(sourceFilter)

	const probe = useKeyedAsyncAction(async (_id: ScrapeTargetId, target: ScrapeTarget) => {
		const result = await probeMutation({
			params: { id: target.id },
			reactivityKeys: ["scrapeTargets"],
		})
		if (!toastExit(result, { error: "Failed to test connection" }) || !Exit.isSuccess(result)) return
		refreshTargets()
		if (result.value.success) {
			toastManager.add({ title: "Connection successful", type: "success" })
		} else {
			toastManager.add({
				title: "Connection failed",
				description: result.value.last_scrape_error ?? undefined,
				type: "error",
			})
		}
	})
	const handleProbe = (target: ScrapeTarget) => void probe.run(target.id, target)

	function openAddDialog() {
		setEditingTarget(null)
		setFormName("")
		setFormServiceName("")
		setFormUrl("")
		setFormInterval("15")
		setFormAuthType("none")
		setFormAuthToken("")
		setFormAuthUsername("")
		setFormAuthPassword("")
		setDialogOpen(true)
	}

	function openEditDialog(target: ScrapeTarget) {
		setEditingTarget(target)
		setFormName(target.name)
		setFormServiceName(target.service_name ?? "")
		setFormUrl(target.url)
		setFormInterval(String(target.scrape_interval_seconds))
		setFormAuthType(target.auth_type)
		setFormAuthToken("")
		setFormAuthUsername("")
		setFormAuthPassword("")
		setDialogOpen(true)
	}

	function buildAuthCredentials(): string | null {
		if (formAuthType === "bearer") {
			if (!formAuthToken.trim()) return null
			return JSON.stringify({ token: formAuthToken.trim() })
		}
		if (formAuthType === "basic") {
			if (!formAuthUsername.trim() && !formAuthPassword.trim()) return null
			return JSON.stringify({
				username: formAuthUsername.trim(),
				password: formAuthPassword.trim(),
			})
		}
		return null
	}

	const parsedInterval = Option.getOrNull(decodeScrapeInterval(Number.parseInt(formInterval, 10) || 15))
	const formValid = formName.trim().length > 0 && formUrl.trim().length > 0 && parsedInterval !== null

	const [handleSave, isSaving] = useAsyncAction(async () => {
		if (!formValid || parsedInterval === null) return
		const authCredentials = buildAuthCredentials()
		const payload = {
			name: formName.trim(),
			scrape_interval_seconds: parsedInterval,
			service_name: formServiceName.trim() || null,
			url: formUrl.trim(),
			auth_type: formAuthType,
			...(authCredentials !== null ? { auth_credentials: authCredentials } : undefined),
		}

		if (editingTarget) {
			const result = await updateMutation({
				params: { id: editingTarget.id },
				payload,
				reactivityKeys: ["scrapeTargets"],
			})
			if (
				!toastExit(result, {
					success: "Scrape target updated",
					error: "Failed to update scrape target",
				})
			)
				return
			refreshTargets()
			setDialogOpen(false)
		} else {
			const result = await createMutation({ payload, reactivityKeys: ["scrapeTargets"] })
			if (
				!toastExit(result, {
					success: "Scrape target created",
					error: "Failed to create scrape target",
				}) ||
				!Exit.isSuccess(result)
			)
				return
			refreshTargets()
			setDialogOpen(false)
			setSelectedTargetId(result.value.id)
		}
	})

	async function handleDelete(targetId: ScrapeTargetId) {
		const result = await deleteMutation({
			params: { id: targetId },
			reactivityKeys: ["scrapeTargets"],
		})
		const ok = toastExit(result, {
			success: "Scrape target deleted",
			error: "Failed to delete scrape target",
		})
		if (ok) {
			refreshTargets()
			if (selectedTargetId === targetId) setSelectedTargetId(null)
		}
		return ok
	}

	const toggle = useKeyedAsyncAction(async (_id: ScrapeTargetId, target: ScrapeTarget) => {
		const result = await updateMutation({
			params: { id: target.id },
			payload: { enabled: !target.enabled },
			reactivityKeys: ["scrapeTargets"],
		})
		if (toastExit(result, { error: "Failed to update scrape target" })) refreshTargets()
	})
	const handleToggleEnabled = (target: ScrapeTarget) => void toggle.run(target.id, target)

	return (
		<>
			<div className="space-y-4">
				{!isEmpty && (
					<div className="flex items-center justify-between gap-3">
						<p className="text-muted-foreground text-sm">{copy.description}</p>
						<Button size="sm" className="shrink-0" onClick={openAddDialog}>
							<PlusIcon data-icon="inline-start" />
							Add target
						</Button>
					</div>
				)}

				{Result.isInitial(listResult) ? (
					<SkeletonList rows={3} rowClassName="h-[60px]" gap="2" />
				) : !Result.isSuccess(listResult) ? (
					<ErrorState
						error={listResult.cause}
						title="Failed to load scrape targets"
						onRetry={() => refreshTargets()}
					/>
				) : targets.length === 0 ? (
					<IntegrationEmpty
						icon={emptyEntry?.icon ?? FireIcon}
						accent={emptyEntry?.accent ?? "#E6522C"}
						iconClassName={emptyEntry?.iconClassName}
					>
						<IntegrationEmptyFeatures>
							{copy.features.map((feature) => (
								<IntegrationEmptyFeature key={feature.label} {...feature} />
							))}
						</IntegrationEmptyFeatures>
						<IntegrationEmptyCard>
							<IntegrationEmptyMedia />
							<IntegrationEmptyHint>{copy.emptyHint}</IntegrationEmptyHint>
							<Button onClick={openAddDialog}>
								<PlusIcon data-icon="inline-start" />
								Add target
							</Button>
							<DocsLink page="prometheus" />
							<IntegrationEmptyFooter>{copy.emptyFooter}</IntegrationEmptyFooter>
						</IntegrationEmptyCard>
					</IntegrationEmpty>
				) : (
					<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
						<Panel className="divide-y">
							{targets.map((target) => (
								<ScrapeTargetRow
									key={target.id}
									target={target}
									selected={target.id === selectedTarget?.id}
									toggling={toggle.isPending(target.id)}
									probing={probe.isPending(target.id)}
									onSelect={setSelectedTargetId}
									onProbe={handleProbe}
									onToggle={handleToggleEnabled}
									onEdit={openEditDialog}
									onDelete={setDeleteConfirmTarget}
								/>
							))}
						</Panel>
						{selectedTarget ? (
							<ScrapeTargetDetails
								target={selectedTarget}
								probing={probe.isPending(selectedTarget.id)}
								toggling={toggle.isPending(selectedTarget.id)}
								onProbe={handleProbe}
								onToggle={handleToggleEnabled}
								onEdit={openEditDialog}
								onDelete={setDeleteConfirmTarget}
							/>
						) : (
							<Panel padded className="hidden lg:flex">
								<div className="text-muted-foreground flex h-full min-h-[260px] flex-col items-center justify-center gap-2 text-center text-xs">
									<CircleInfoIcon size={18} />
									<span>Click a target to inspect scheduled checks.</span>
								</div>
							</Panel>
						)}
					</div>
				)}
			</div>

			<FormDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				title={editingTarget ? "Edit scrape target" : "Add scrape target"}
				description={
					editingTarget
						? "Update the scrape target configuration."
						: "Enter the URL of a Prometheus exporter endpoint. Maple will periodically scrape this endpoint for metrics."
				}
				onSubmit={() => void handleSave()}
				submitLabel={editingTarget ? "Save changes" : "Add target"}
				pending={isSaving}
				submitDisabled={!formValid}
			>
				<Field>
					<FieldLabel htmlFor="scrape-name">Name</FieldLabel>
					<Input
						id="scrape-name"
						placeholder="e.g. Node Exporter"
						value={formName}
						onChange={(e) => setFormName(e.target.value)}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="scrape-service-name">Service name</FieldLabel>
					<Input
						id="scrape-service-name"
						placeholder="e.g. my-api-server"
						value={formServiceName}
						onChange={(e) => setFormServiceName(e.target.value)}
					/>
					<FieldDescription>
						Metrics will appear under this service name. Defaults to the target name if empty.
					</FieldDescription>
				</Field>
				<Field>
					<FieldLabel htmlFor="scrape-url">URL</FieldLabel>
					<Input
						id="scrape-url"
						placeholder="e.g. https://myapp.com:9090/metrics"
						value={formUrl}
						onChange={(e) => setFormUrl(e.target.value)}
					/>
				</Field>
				<Field invalid={parsedInterval === null}>
					<FieldLabel htmlFor="scrape-interval">Scrape interval (seconds)</FieldLabel>
					<Input
						id="scrape-interval"
						type="number"
						min={5}
						max={300}
						value={formInterval}
						onChange={(e) => setFormInterval(e.target.value)}
					/>
					{parsedInterval === null ? (
						<FieldError match>
							Scrape interval must be an integer from 5 to 300 seconds.
						</FieldError>
					) : null}
				</Field>
				<Field>
					<FieldLabel>Authentication</FieldLabel>
					<Select
						items={{ none: "None", bearer: "Bearer Token", basic: "Basic Auth" }}
						value={formAuthType}
						onValueChange={(val: string | null) => {
							setFormAuthType(val === "bearer" || val === "basic" ? val : "none")
							setFormAuthToken("")
							setFormAuthUsername("")
							setFormAuthPassword("")
						}}
					>
						<SelectTrigger className="w-full">
							<SelectValue placeholder="Select auth type" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">None</SelectItem>
							<SelectItem value="bearer">Bearer Token</SelectItem>
							<SelectItem value="basic">Basic Auth</SelectItem>
						</SelectContent>
					</Select>
				</Field>
				{formAuthType === "bearer" && (
					<Field>
						<FieldLabel htmlFor="scrape-auth-token">Bearer Token</FieldLabel>
						<Input
							id="scrape-auth-token"
							type="password"
							placeholder={
								editingTarget?.has_credentials && editingTarget.auth_type === "bearer"
									? "Leave blank to keep existing"
									: "Enter bearer token"
							}
							value={formAuthToken}
							onChange={(e) => setFormAuthToken(e.target.value)}
						/>
					</Field>
				)}
				{formAuthType === "basic" && (
					<>
						<Field>
							<FieldLabel htmlFor="scrape-auth-username">Username</FieldLabel>
							<Input
								id="scrape-auth-username"
								placeholder={
									editingTarget?.has_credentials && editingTarget.auth_type === "basic"
										? "Leave blank to keep existing"
										: "Enter username"
								}
								value={formAuthUsername}
								onChange={(e) => setFormAuthUsername(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="scrape-auth-password">Password</FieldLabel>
							<Input
								id="scrape-auth-password"
								type="password"
								placeholder={
									editingTarget?.has_credentials && editingTarget.auth_type === "basic"
										? "Leave blank to keep existing"
										: "Enter password"
								}
								value={formAuthPassword}
								onChange={(e) => setFormAuthPassword(e.target.value)}
							/>
						</Field>
					</>
				)}
			</FormDialog>

			<ConfirmDialog
				open={deleteConfirmTarget !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteConfirmTarget(null)
				}}
				title="Delete scrape target?"
				description={
					<>
						Are you sure you want to delete{" "}
						<span className="font-medium text-foreground">{deleteConfirmTarget?.name}</span>? This
						action cannot be undone.
					</>
				}
				confirmLabel="Delete"
				onConfirm={() => (deleteConfirmTarget ? handleDelete(deleteConfirmTarget.id) : undefined)}
			/>
		</>
	)
}

function ScrapeTargetRow({
	target,
	selected,
	toggling,
	probing,
	onSelect,
	onProbe,
	onToggle,
	onEdit,
	onDelete,
}: {
	target: ScrapeTarget
	selected: boolean
	toggling: boolean
	probing: boolean
	onSelect: (targetId: ScrapeTargetId) => void
	onProbe: (target: ScrapeTarget) => void
	onToggle: (target: ScrapeTarget) => void
	onEdit: (target: ScrapeTarget) => void
	onDelete: (target: ScrapeTarget) => void
}) {
	const status = scheduledStatusFromRollup(target)

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault()
			onSelect(target.id)
		}
	}

	return (
		<div
			role="button"
			tabIndex={0}
			aria-pressed={selected}
			onClick={() => onSelect(target.id)}
			onKeyDown={handleKeyDown}
			className={cn(
				"flex cursor-pointer items-center gap-3 px-3 py-3 outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50",
				selected && "bg-muted/60",
			)}
		>
			<StatusDot tone={status.tone} size="lg" />

			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="min-w-16 truncate text-sm font-medium" title={target.name}>
						{target.name}
					</span>
					<Badge variant={status.tone === "neutral" ? "outline" : status.tone} className="shrink-0">
						{status.label}
					</Badge>
					{target.service_name && (
						<Badge variant="outline" className="min-w-0 max-w-40" title={target.service_name}>
							<span className="truncate">{target.service_name}</span>
						</Badge>
					)}
					{target.auth_type !== "none" && (
						<Badge variant="outline" className="shrink-0">
							{AUTH_TYPE_LABELS[target.auth_type] ?? target.auth_type}
						</Badge>
					)}
				</div>
				<div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
					<span className="max-w-[280px] truncate font-mono" title={target.url}>
						{hostnameFromUrl(target.url)}
					</span>
					<span>{target.scrape_interval_seconds}s interval</span>
					<span>{status.detail}</span>
					{target.last_scrape_at && (
						<RelativeTime value={target.last_scrape_at} prefix="Last scrape" tooltip="title" />
					)}
				</div>
				{target.last_scrape_error && (
					<Tooltip>
						<TooltipTrigger
							render={<div />}
							className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"
						>
							<CircleInfoIcon size={12} className="shrink-0" />
							<span className="truncate">Last scrape: {target.last_scrape_error}</span>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs font-mono text-xs">
							{target.last_scrape_error}
						</TooltipContent>
					</Tooltip>
				)}
			</div>

			<div onClick={(event) => event.stopPropagation()}>
				<Switch
					checked={target.enabled}
					onCheckedChange={() => onToggle(target)}
					disabled={toggling}
				/>
			</div>

			<Button
				variant="outline"
				size="sm"
				onClick={(event) => {
					event.stopPropagation()
					onProbe(target)
				}}
				loading={probing}
			>
				<BoltIcon />
				Test
			</Button>

			<div onClick={(event) => event.stopPropagation()}>
				<RowActionsMenu
					label={`Actions for ${target.name}`}
					className="text-muted-foreground hover:text-foreground shrink-0"
				>
					{/* Managed targets are edited/removed through the owning integration card. */}
					<DropdownMenuItem disabled={target.managed_by != null} onClick={() => onEdit(target)}>
						<PencilIcon />
						Edit
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="destructive"
						disabled={target.managed_by != null}
						onClick={() => onDelete(target)}
					>
						<TrashIcon />
						Delete
					</DropdownMenuItem>
				</RowActionsMenu>
			</div>
		</div>
	)
}

function ScrapeTargetDetails({
	target,
	probing,
	toggling,
	onProbe,
	onToggle,
	onEdit,
	onDelete,
}: {
	target: ScrapeTarget
	probing: boolean
	toggling: boolean
	onProbe: (target: ScrapeTarget) => void
	onToggle: (target: ScrapeTarget) => void
	onEdit: (target: ScrapeTarget) => void
	onDelete: (target: ScrapeTarget) => void
}) {
	const { result: checksResult } = useScrapeTargetChecks(target.id)
	const checks = checksFromResult(checksResult)
	const latestCheck = checks.at(0) ?? null
	const status = scheduledStatusFromChecks(
		target,
		latestCheck,
		Result.isInitial(checksResult),
		Result.isFailure(checksResult),
	)
	const labels = labelEntries(target.labels_json)

	// Diagnose the freshest failure: the latest failed check, falling back to the
	// target-level rollup error. Healthy targets show no banner.
	const failureMessage =
		latestCheck && !latestCheck.success ? latestCheck.message : target.last_scrape_error
	const diagnosis = diagnoseScrapeError(failureMessage, target.target_type)
	const formatDateTime = useFormatDateTime()

	return (
		<Panel>
			<div className="space-y-3 border-b p-4">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<StatusDot tone={status.tone} size="lg" />
							<h3 className="truncate text-sm font-semibold" title={target.name}>
								{target.name}
							</h3>
						</div>
						<p
							className="text-muted-foreground mt-1 line-clamp-2 break-all font-mono text-xs"
							title={target.url}
						>
							{target.url}
						</p>
					</div>
					<Badge variant={status.tone === "neutral" ? "outline" : status.tone}>
						{status.label}
					</Badge>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button variant="outline" size="sm" onClick={() => onProbe(target)} loading={probing}>
						<BoltIcon />
						Test
					</Button>
					{/* Managed targets are edited/removed through the owning integration card. */}
					<Button
						variant="outline"
						size="sm"
						onClick={() => onEdit(target)}
						disabled={target.managed_by != null}
					>
						<PencilIcon />
						Edit
					</Button>
					<Button variant="ghost" size="sm" onClick={() => onToggle(target)} disabled={toggling}>
						{target.enabled ? "Disable" : "Enable"}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="text-destructive"
						onClick={() => onDelete(target)}
						disabled={target.managed_by != null}
					>
						<TrashIcon />
						Delete
					</Button>
				</div>
			</div>

			<div className="space-y-5 p-4">
				{diagnosis && (
					<Alert variant={diagnosis.severity}>
						<CircleWarningIcon size={16} />
						<AlertTitle>{diagnosis.title}</AlertTitle>
						<AlertDescription>
							<p>{diagnosis.summary}</p>
							<div className="space-y-1">
								<p className="font-medium text-foreground">How to fix</p>
								<ul className="list-disc space-y-0.5 pl-4">
									{diagnosis.fixes.map((fix) => (
										<li key={fix}>{fix}</li>
									))}
								</ul>
							</div>
							{failureMessage && (
								<p className="font-mono text-2xs text-muted-foreground/80">
									{failureMessage}
								</p>
							)}
						</AlertDescription>
					</Alert>
				)}

				<section className="space-y-2">
					<Eyebrow variant="label" className="flex items-center gap-2" as="div">
						<PulseIcon size={13} />
						Scheduled scrape
					</Eyebrow>
					<div className="grid grid-cols-2 gap-2 text-xs">
						<MetricBox label="Interval" value={`${target.scrape_interval_seconds}s`} />
						<MetricBox
							label="Duration"
							value={
								latestCheck
									? formatDurationSeconds(latestCheck.duration_seconds)
									: EMPTY_VALUE
							}
						/>
						<MetricBox
							label="Samples"
							value={
								latestCheck ? formatOptionalCount(latestCheck.samples_scraped) : EMPTY_VALUE
							}
						/>
						<MetricBox
							label="Post relabel"
							value={
								latestCheck
									? formatOptionalCount(latestCheck.samples_post_metric_relabeling)
									: EMPTY_VALUE
							}
						/>
					</div>
				</section>

				<section className="space-y-2">
					<Eyebrow variant="label" className="flex items-center gap-2" as="div">
						<ExternalLinkIcon size={13} />
						Target
					</Eyebrow>
					<KeyValueList divided className="rounded-md border bg-background/35 px-3">
						<KeyValue label="Service">{target.service_name ?? target.name}</KeyValue>
						<KeyValue label="Instance">{hostnameFromUrl(target.url)}</KeyValue>
						<KeyValue label="Auth">
							{AUTH_TYPE_LABELS[target.auth_type] ?? target.auth_type}
						</KeyValue>
						<KeyValue label="Target ID" mono>
							{target.id}
						</KeyValue>
						<KeyValue label="Created">{formatDateTime(target.created_at)}</KeyValue>
						<KeyValue label="Updated">{formatDateTime(target.updated_at)}</KeyValue>
					</KeyValueList>
					{labels.length > 0 && (
						<div className="flex flex-wrap gap-1.5 pt-1">
							{labels.map(([key, value]) => (
								<Badge key={key} variant="outline" className="max-w-full">
									<span className="truncate font-mono">
										{key}={value}
									</span>
								</Badge>
							))}
						</div>
					)}
				</section>

				<section className="space-y-2">
					<div className="flex items-center justify-between gap-3">
						<Eyebrow variant="label" className="flex items-center gap-2" as="div">
							<HistoryIcon size={13} />
							Check history
						</Eyebrow>
						{latestCheck && (
							<RelativeTime
								value={latestCheck.timestamp}
								prefix="Latest"
								className="text-muted-foreground text-xs"
							/>
						)}
					</div>
					<ScrapeTargetChecksTable result={checksResult} checks={checks} />
				</section>
			</div>
		</Panel>
	)
}

function MetricBox({ label, value }: { label: string; value: string }) {
	return (
		<Panel tone="background" className="px-3 py-2">
			<Eyebrow as="div">{label}</Eyebrow>
			<div className="mt-1 font-mono text-sm">{value}</div>
		</Panel>
	)
}

export function ScrapeTargetChecksTable({
	result,
	checks,
}: {
	result: ScrapeTargetChecksResult
	checks: ScrapeTargetCheck[]
}) {
	const formatDateTime = useFormatDateTime()
	if (Result.isInitial(result)) {
		return <SkeletonList rows={3} gap="2" />
	}
	if (!Result.isSuccess(result)) {
		return <ErrorState error={result.cause} title="Failed to load scheduled checks" variant="row" />
	}
	if (checks.length === 0) {
		return (
			<EmptyMessage className="rounded-md border bg-background/35 px-3 py-6">
				The first scrape runs shortly after you save. Use Test to check the endpoint now.
			</EmptyMessage>
		)
	}

	return (
		<Panel tone="background">
			<Table size="sm">
				<TableHeader>
					<TableRow>
						<TableHead className="w-full pl-3">Time</TableHead>
						<TableHead className="w-[64px]">State</TableHead>
						<TableHead className="w-[70px]">Duration</TableHead>
						<TableHead className="w-[72px] pr-3">Samples</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{checks.map((check) => (
						<TableRow key={`${check.timestamp}-${check.sub_target_key ?? ""}`}>
							{/* max-w-0 lets the flexible column truncate instead of widening the table. */}
							<TableCell className="max-w-0 min-w-[100px] pl-3">
								<div className="truncate font-mono">{formatDateTime(check.timestamp)}</div>
								{check.message && (
									<Tooltip>
										<TooltipTrigger
											render={<div />}
											className="text-muted-foreground mt-0.5 cursor-default truncate"
										>
											{check.message}
										</TooltipTrigger>
										<TooltipContent className="max-w-xs font-mono text-xs">
											{check.message}
										</TooltipContent>
									</Tooltip>
								)}
							</TableCell>
							<TableCell>
								<span className="flex items-center gap-1.5">
									{check.success ? (
										<CircleCheckIcon size={12} className="text-severity-info" />
									) : (
										<CircleXmarkIcon size={12} className="text-severity-error" />
									)}
									<span>{check.success ? "up" : "down"}</span>
								</span>
							</TableCell>
							<TableCell className="font-mono">
								{formatDurationSeconds(check.duration_seconds)}
							</TableCell>
							<TableCell className="pr-3 font-mono">
								{formatOptionalCount(check.samples_scraped)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</Panel>
	)
}
