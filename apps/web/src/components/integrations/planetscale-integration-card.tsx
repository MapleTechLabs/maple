import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { useMemo, useState } from "react"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Item, ItemActions, ItemContent, ItemMedia } from "@maple/ui/components/ui/item"
import { Field, FieldDescription, FieldLabel } from "@maple/ui/components/ui/field"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { PlanetScaleIcon } from "@/components/icons"
import { Panel } from "@maple/ui/components/ui/panel"
import { OptionCard } from "@/components/common/option-card"
import { isExcluded } from "@/components/infra/planetscale/branch-selection"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useMutationAction } from "@/hooks/use-mutation-action"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { IntegrationIconPlate, catalogEntry } from "./integration-catalog"
import { useRequiredIntegrationConnect } from "./integration-connect"
import { useIntegrationDisconnect } from "./use-integration-disconnect"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"
import { PlanetScaleMetricsHealth, QUIET_LINK } from "./planetscale-metrics-health"
import { PlanetScaleMetricsTokenForm } from "./planetscale-metrics-token-form"
import { PlanetScaleSetupChecklist } from "./planetscale-setup-checklist"
import { derivePlanetScaleSetup } from "./planetscale-setup-steps"

const PLANETSCALE_ENTRY = catalogEntry("planetscale")

/** Comma/newline separated globs → trimmed list. */
const parsePatternList = (value: string): string[] =>
	value
		.split(/[\n,]/)
		.map((pattern) => pattern.trim())
		.filter((pattern) => pattern.length > 0)

/**
 * First-class PlanetScale connection card: authorize Maple's OAuth application
 * in a popup, pick the PlanetScale organization (auto-bound when the grant
 * reaches exactly one), and Maple collects branch metrics, polls database
 * inventory, and proxies query insights automatically. Collection health shows
 * as a single status row — the machinery stays out of the UI.
 */
export function PlanetScaleIntegrationCard() {
	const statusQuery = retainedQueryV2("planetscaleIntegration", "status", {
		reactivityKeys: ["planetscaleIntegration"],
	})
	const statusResult = useAtomValue(statusQuery)
	const refreshStatus = useAtomRefresh(statusQuery)

	const disconnect = useAtomSet(MapleApiV2AtomClient.mutation("planetscaleIntegration", "disconnect"), {
		mode: "promiseExit",
	})

	// Connect flow (popup, busy, refresh-on-return) lives in IntegrationConnectProvider —
	// shared with the drill-in header's Connect button.
	const connectFlow = useRequiredIntegrationConnect("PlanetScaleIntegrationCard")
	const { disconnect: runDisconnect, pending: disconnectBusy } = useIntegrationDisconnect(
		() => disconnect({ reactivityKeys: ["planetscaleIntegration", "scrapeTargets"] }),
		{
			success: "PlanetScale organization disconnected",
			error: "Failed to disconnect PlanetScale organization",
		},
	)
	const actionBusy = connectFlow.busy || disconnectBusy
	const [pickerOpen, setPickerOpen] = useState(false)
	const [rotateOpen, setRotateOpen] = useState(false)
	const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() => null)
	const isConnected = status?.connected === true
	const pendingOrgSelection = status?.pending_org_selection === true

	// Recomputed on every render (including each poll tick), so the elapsed-time
	// copy below advances without a second timer.
	const setup = status !== null ? derivePlanetScaleSetup(status, Date.now()) : null
	const awaitingFirstScrape = setup?.awaitingFirstScrape === true

	// Once a token is saved the first scrape lands within a scrape interval —
	// poll so "waiting" becomes "streaming" in place, without a reload.
	useIntervalRefresh(refreshStatus, { intervalMs: 5_000, enabled: awaitingFirstScrape })
	// When the watch began. Captured once per mount; PlanetScale gives us no
	// "token added at" timestamp, so this measures how long *we* have been
	// looking, and the copy says exactly that rather than inventing a duration.
	const [watchStartedAt] = useState(() => Date.now())
	const watchedForMs = Date.now() - watchStartedAt

	async function handleDisconnect() {
		if (await runDisconnect()) refreshStatus()
	}
	const disconnectConfirm = (
		<ConfirmDialog
			open={confirmingDisconnect}
			onOpenChange={setConfirmingDisconnect}
			title="Disconnect PlanetScale"
			description="Maple stops collecting data from PlanetScale. You can reconnect later."
			confirmLabel="Disconnect"
			onConfirm={() => {
				setConfirmingDisconnect(false)
				void handleDisconnect()
			}}
		/>
	)

	// Guard the first fetch so a connected org doesn't flash the "Connect" empty state.
	if (Result.isInitial(statusResult)) {
		return <Skeleton className="h-40 w-full rounded-md" />
	}

	// A failed status fetch is not "not connected" — don't offer the connect CTA
	// over an org that may already be authorized.
	if (Result.isFailure(statusResult)) {
		return (
			<Item variant="card" className="items-start gap-4 p-4">
				<ItemMedia>
					<IntegrationIconPlate icon={PlanetScaleIcon} accent={PLANETSCALE_ENTRY.accent} />
				</ItemMedia>
				<ItemContent>
					<h3 className="text-sm font-semibold">PlanetScale</h3>
					<p className="text-xs text-muted-foreground">
						Couldn&apos;t load the PlanetScale connection status — refresh the page to try again.
					</p>
				</ItemContent>
			</Item>
		)
	}

	// Grant stored, organization not chosen yet: the picker is the whole card.
	if (!isConnected && pendingOrgSelection) {
		return (
			<Panel>
				<Item className="items-start gap-3 rounded-none p-4">
					<ItemMedia>
						<IntegrationIconPlate icon={PlanetScaleIcon} accent={PLANETSCALE_ENTRY.accent} />
					</ItemMedia>
					<ItemContent className="gap-0">
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-semibold">PlanetScale</h3>
							<Badge variant="secondary">Authorized</Badge>
						</div>
						<p className="mt-1 text-xs text-muted-foreground">
							The authorization covers multiple PlanetScale organizations — choose which one to
							connect.
						</p>
					</ItemContent>
				</Item>
				<div className="border-t border-border/60 p-4">
					<PlanetScaleOrgPicker
						onDone={() => refreshStatus()}
						onCancel={() => setConfirmingDisconnect(true)}
						cancelLabel="Disconnect"
					/>
				</div>
				{disconnectConfirm}
			</Panel>
		)
	}

	if (!isConnected) {
		return (
			<IntegrationEmpty
				icon={PlanetScaleIcon}
				accent={PLANETSCALE_ENTRY.accent}
				iconClassName={PLANETSCALE_ENTRY.iconClassName}
			>
				<IntegrationEmptyFeatures>
					<IntegrationEmptyFeature
						label="Service map"
						title="Databases join the map"
						description="Linked to the services that query them, with branches tracked automatically."
					/>
					<IntegrationEmptyFeature
						label="Query insights"
						title="Top queries per branch"
						description="Calls, rows read, and time per query — proxied straight from PlanetScale."
					/>
					<IntegrationEmptyFeature
						label="Branch health"
						title="CPU, memory, replication"
						description="Connections and replication lag per branch, scraped on a schedule."
					/>
				</IntegrationEmptyFeatures>
				<IntegrationEmptyCard>
					<IntegrationEmptyMedia />
					<IntegrationEmptyHint>
						Your databases and branches will appear here after connecting.
					</IntegrationEmptyHint>
					<Button onClick={connectFlow.connect} disabled={actionBusy} loading={connectFlow.busy}>
						<PlanetScaleIcon />
						Connect PlanetScale
					</Button>
				</IntegrationEmptyCard>
			</IntegrationEmpty>
		)
	}

	return (
		<div className="flex flex-col gap-4">
			<Panel>
				<Item className="items-start gap-3 rounded-none p-4">
					<ItemMedia>
						<IntegrationIconPlate icon={PlanetScaleIcon} accent={PLANETSCALE_ENTRY.accent} />
					</ItemMedia>
					<ItemContent className="gap-0">
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-semibold">PlanetScale</h3>
							{/* "Connected" while three of four steps are done overstates it —
							    the badge tracks the checklist. */}
							{setup !== null && !setup.complete ? (
								<Badge variant="warn">
									Step {setup.activeStepNumber} of {setup.steps.length}
								</Badge>
							) : (
								<Badge variant="ok">Connected</Badge>
							)}
						</div>
						<p className="mt-1 text-xs text-muted-foreground">
							{setup !== null && !setup.complete ? (
								<>
									Connected to{" "}
									<span className="font-medium text-foreground">
										{status?.organization}
									</span>
									{" — inventory, insights, and webhooks are live."}
								</>
							) : (
								<>
									Streaming branch metrics from{" "}
									<span className="font-medium text-foreground">
										{status?.organization}
									</span>
								</>
							)}
						</p>
					</ItemContent>

					<ItemActions className="shrink-0 gap-1.5">
						<Button
							size="sm"
							variant="outline"
							onClick={() => setPickerOpen(true)}
							disabled={actionBusy}
						>
							Change organization
						</Button>
						<Button
							size="sm"
							variant="outline"
							onClick={() => setConfirmingDisconnect(true)}
							disabled={actionBusy}
							loading={disconnectBusy}
						>
							Disconnect
						</Button>
						{disconnectConfirm}
					</ItemActions>
				</Item>

				{/* Setup is only shown while there is setup left. A finished
				    connection collapses to the single health row it has always been. */}
				{status !== null && setup !== null && !setup.complete ? (
					<div className="border-t border-border/60 p-4">
						<PlanetScaleSetupChecklist
							steps={setup.steps}
							actions={{
								connected: (
									<Button
										size="sm"
										onClick={connectFlow.connect}
										disabled={actionBusy}
										loading={connectFlow.busy}
									>
										Reconnect
									</Button>
								),
								permissions: (
									<Button
										size="sm"
										onClick={connectFlow.connect}
										disabled={actionBusy}
										loading={connectFlow.busy}
									>
										Reauthorize with read_databases
									</Button>
								),
								"metrics-token": (
									<PlanetScaleMetricsTokenForm
										organization={status.organization}
										docsUrl={PLANETSCALE_ENTRY.docsUrl}
										mode="initial"
										onSaved={refreshStatus}
									/>
								),
								"first-metrics": (
									<FirstMetricsDetail
										scrapeError={status.scrape_target?.last_scrape_error ?? null}
										watchedForMs={watchedForMs}
										onRotate={() => setRotateOpen(true)}
									/>
								),
							}}
						/>
					</div>
				) : null}

				{status !== null && status.scrape_target !== null && setup?.complete === true ? (
					<PlanetScaleMetricsHealth
						target={status.scrape_target}
						metricsAuth={status.metrics_auth}
						action={
							status.metrics_auth === "service_token" && !rotateOpen ? (
								<Button
									variant="link"
									size="xs"
									onClick={() => setRotateOpen(true)}
									className={`h-auto p-0 font-normal ${QUIET_LINK}`}
								>
									Rotate token
								</Button>
							) : null
						}
					/>
				) : null}

				{rotateOpen && status !== null ? (
					<div className="border-t border-border/60 p-4">
						<PlanetScaleMetricsTokenForm
							organization={status.organization}
							docsUrl={PLANETSCALE_ENTRY.docsUrl}
							mode="rotate"
							onSaved={() => {
								setRotateOpen(false)
								refreshStatus()
							}}
							onCancel={() => setRotateOpen(false)}
						/>
					</div>
				) : null}
			</Panel>

			<PlanetScaleWebhookSetup />

			{/* Re-binding to another org the grant covers — finalize is an upsert. */}
			<Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Change PlanetScale organization</DialogTitle>
						<DialogDescription>
							Pick another organization the authorization covers. Metrics collection follows
							automatically.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel>
						<PlanetScaleOrgPicker
							initialOrganization={status?.organization ?? null}
							initialIncludeBranches={status?.scrape_target?.include_branches.join(", ") ?? ""}
							initialExcludeBranches={status?.scrape_target?.exclude_branches.join(", ") ?? ""}
							onDone={() => {
								setPickerOpen(false)
								refreshStatus()
							}}
							onCancel={() => setPickerOpen(false)}
							cancelLabel="Cancel"
						/>
					</DialogPanel>
				</DialogContent>
			</Dialog>
		</div>
	)
}

/**
 * The action attached to the "Metrics arriving" step while it is current or
 * blocked. Three outcomes, three different next moves — a generic "waiting"
 * spinner would leave a wrong-permission token spinning forever.
 */
function FirstMetricsDetail({
	scrapeError,
	watchedForMs,
	onRotate,
}: {
	scrapeError: string | null
	/** How long this card has been open. See the note at the call site. */
	watchedForMs: number
	onRotate: () => void
}) {
	if (scrapeError !== null) {
		return (
			<div className="space-y-2">
				<p className="break-all rounded-md bg-muted/40 p-2 font-mono text-xs text-muted-foreground">
					{scrapeError}
				</p>
				<Button size="sm" variant="outline" onClick={onRotate}>
					Rotate token
				</Button>
			</div>
		)
	}

	// Three minutes is several scrape intervals at the 30s default: long enough
	// that "usually under a minute" has stopped being true.
	if (watchedForMs < 3 * 60 * 1000) {
		return (
			<p className="text-xs text-muted-foreground">Usually under a minute — this updates on its own.</p>
		)
	}

	return (
		<div className="space-y-2">
			<p className="text-xs text-muted-foreground">
				Still nothing after a few minutes. The most common cause is a token without the{" "}
				<InlineCode>read_metrics_endpoints</InlineCode> permission — PlanetScale accepts the token and
				then serves no metrics.
			</p>
			<Button size="sm" variant="outline" onClick={onRotate}>
				Rotate token
			</Button>
		</div>
	)
}

/**
 * Organization picker over the stored OAuth grant: lists the orgs the grant can
 * access and finalizes the binding via select-organization. Rendered inline for
 * the pending state and inside a dialog for post-connect re-binding.
 */
function PlanetScaleOrgPicker(props: {
	initialOrganization?: string | null
	initialIncludeBranches?: string
	initialExcludeBranches?: string
	onDone: () => void
	onCancel: () => void
	cancelLabel: string
}) {
	const organizationsResult = useAtomValue(
		retainedQueryV2("planetscaleIntegration", "organizations", {
			reactivityKeys: ["planetscaleIntegration"],
		}),
	)
	// Powers the live filter preview. Empty before the first inventory poll, which
	// is exactly the pending-org-selection case — the preview then stays quiet.
	const inventoryResult = useAtomValue(
		retainedQueryV2("planetscaleIntegration", "databases", {
			reactivityKeys: ["planetscaleIntegration"],
		}),
	)
	const [selected, setSelected] = useState<string | null>(props.initialOrganization ?? null)
	const [selectOrganization, submitting] = useMutationAction(
		MapleApiV2AtomClient.mutation("planetscaleIntegration", "selectOrganization"),
		{
			success: () => `PlanetScale organization ${selected} connected`,
			error: "Failed to connect PlanetScale organization",
			onSuccess: () => props.onDone(),
		},
	)

	const [includeBranches, setIncludeBranches] = useState(props.initialIncludeBranches ?? "")
	const [excludeBranches, setExcludeBranches] = useState(props.initialExcludeBranches ?? "")

	const branchNames = useMemo(
		() =>
			Result.builder(inventoryResult)
				.onSuccess((inventory) => [
					...new Set(inventory.databases.flatMap((db) => db.branches.map((b) => b.name))),
				])
				.orElse<ReadonlyArray<string>>(() => []),
		[inventoryResult],
	)
	const preview = useMemo(() => {
		const include = parsePatternList(includeBranches)
		const exclude = parsePatternList(excludeBranches)
		if (branchNames.length === 0 || (include.length === 0 && exclude.length === 0)) return null
		const dropped = branchNames.filter((name) => isExcluded(name, include, exclude))
		return { total: branchNames.length, kept: branchNames.length - dropped.length, dropped }
	}, [branchNames, includeBranches, excludeBranches])

	async function handleSubmit() {
		if (selected === null) return
		const include = parsePatternList(includeBranches)
		const exclude = parsePatternList(excludeBranches)
		await selectOrganization({
			payload: {
				organization: selected,
				...(include.length > 0 ? { include_branches: include } : undefined),
				...(exclude.length > 0 ? { exclude_branches: exclude } : undefined),
			},
			// finalizeOrgSelection re-parents the managed scrape target — refresh the list below.
			reactivityKeys: ["planetscaleIntegration", "scrapeTargets"],
		})
	}

	if (Result.isInitial(organizationsResult)) {
		return <Skeleton className="h-24 w-full" />
	}
	if (Result.isFailure(organizationsResult)) {
		return (
			<p className="text-xs text-muted-foreground">
				Couldn&apos;t list the authorized PlanetScale organizations — the authorization may have been
				revoked. Disconnect and connect again.
			</p>
		)
	}
	const organizations = organizationsResult.value.organizations

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5" role="radiogroup" aria-label="PlanetScale organization">
				{organizations.map((org) => (
					<OptionCard
						key={org.id}
						type="radio"
						name="planetscale-organization"
						checked={selected === org.name}
						onChange={() => setSelected(org.name)}
						label={org.name}
						title={<span className="truncate">{org.name}</span>}
					/>
				))}
			</div>
			<div className="flex flex-col gap-3">
				<Field className="items-stretch gap-1.5">
					<FieldLabel htmlFor="ps-include-branches">Only these branches (optional)</FieldLabel>
					<Input
						id="ps-include-branches"
						placeholder="main, staging"
						value={includeBranches}
						onChange={(event) => setIncludeBranches(event.target.value)}
						autoComplete="off"
					/>
					<FieldDescription>
						Leave blank to collect every branch. When set, only matching branches are collected —
						exclusions still apply on top.
					</FieldDescription>
				</Field>
				<Field className="items-stretch gap-1.5">
					<FieldLabel htmlFor="ps-exclude-branches">Exclude branches (optional)</FieldLabel>
					<Input
						id="ps-exclude-branches"
						placeholder="pr-*, preview-*"
						value={excludeBranches}
						onChange={(event) => setExcludeBranches(event.target.value)}
						autoComplete="off"
					/>
					<FieldDescription>
						Glob patterns — <InlineCode>*</InlineCode> matches any run, <InlineCode>?</InlineCode>{" "}
						exactly one character.
					</FieldDescription>
				</Field>
				{/* The preview shares its glob implementation with the scraper
				    (@maple/domain/glob), so what it counts is what gets collected. */}
				{preview !== null ? (
					<p className="text-xs text-muted-foreground">
						<span className="font-medium text-foreground">
							{preview.kept} of {preview.total}
						</span>{" "}
						branches will be collected
						{preview.dropped.length > 0 ? (
							<>
								{" — skipping "}
								<span className="font-mono">{preview.dropped.slice(0, 6).join(", ")}</span>
								{preview.dropped.length > 6 ? ` and ${preview.dropped.length - 6} more` : ""}
							</>
						) : null}
					</p>
				) : null}
			</div>
			<DialogFooter>
				<Button variant="outline" onClick={props.onCancel} disabled={submitting}>
					{props.cancelLabel}
				</Button>
				<Button onClick={() => void handleSubmit()} disabled={selected === null} loading={submitting}>
					Connect organization
				</Button>
			</DialogFooter>
		</div>
	)
}

/**
 * Manual webhook setup: PlanetScale webhooks are configured per database in
 * the PlanetScale dashboard, so Maple shows the endpoint URL + HMAC secret to
 * paste there. The secret is fetched (admin-only) only after the reveal click.
 */
function PlanetScaleWebhookSetup() {
	const [revealed, setRevealed] = useState(false)
	return (
		<Panel>
			<Item className="items-start gap-3 rounded-none p-4">
				<ItemContent className="gap-0">
					<h3 className="text-sm font-semibold">Webhooks</h3>
					<p className="mt-1 text-xs text-muted-foreground">
						Register this endpoint in each database&apos;s webhook settings on PlanetScale — OOM
						restarts, storage thresholds, and anomalies then open triage issues in Maple.
					</p>
				</ItemContent>
				{!revealed ? (
					<ItemActions>
						<Button size="sm" variant="outline" onClick={() => setRevealed(true)}>
							Show setup
						</Button>
					</ItemActions>
				) : null}
			</Item>
			{revealed ? <PlanetScaleWebhookConfig /> : null}
		</Panel>
	)
}

function PlanetScaleWebhookConfig() {
	const configResult = useAtomValue(
		retainedQueryV2("planetscaleIntegration", "webhookConfig", {
			reactivityKeys: ["planetscaleIntegration"],
		}),
	)
	if (Result.isInitial(configResult)) {
		return <Skeleton className="mx-4 mb-4 h-16" />
	}
	if (Result.isFailure(configResult)) {
		return (
			<p className="px-4 pb-4 text-xs text-muted-foreground">
				Couldn&apos;t load the webhook configuration — only org admins can view it.
			</p>
		)
	}
	const config = configResult.value
	if (!config.configured || !config.url || !config.secret) {
		return (
			<p className="px-4 pb-4 text-xs text-muted-foreground">
				No webhook secret on this connection yet — reconnect to mint one.
			</p>
		)
	}
	return (
		<div className="space-y-3 border-t border-border/60 p-4">
			<KeyValueList layout="stacked">
				<KeyValue label={<Eyebrow>Webhook URL</Eyebrow>} mono wrap>
					{config.url}
				</KeyValue>
				<KeyValue label={<Eyebrow>Secret</Eyebrow>} mono wrap>
					{config.secret}
				</KeyValue>
			</KeyValueList>
			<p className="text-2xs text-muted-foreground">
				PlanetScale signs each delivery with this secret (
				<InlineCode>X-PlanetScale-Signature</InlineCode>); Maple rejects anything that doesn&apos;t
				verify.
			</p>
		</div>
	)
}
