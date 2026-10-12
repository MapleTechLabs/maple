import { countLabel, EMPTY_VALUE } from "@maple/ui/lib/format"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { useAtomSet } from "@/lib/effect-atom"
import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { Exit } from "effect"
import type { V2ApiKey } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"

import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { DropdownMenuItem } from "@maple/ui/components/ui/dropdown-menu"
import { Panel } from "@maple/ui/components/ui/panel"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { SegmentedSelect } from "@/components/common/segmented-select"
import { DocsLink, EmptyActions } from "@/components/common/docs-link"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { ColumnHead, DataTable } from "@/components/common/data-table"
import { RelativeTime } from "@/components/common/relative-time"
import { ArrowPathIcon, CodeIcon, KeyIcon, PlusIcon, SquareTerminalIcon, TrashIcon } from "@/components/icons"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"
import { useApiKeyMutationSync, useApiKeysList } from "@/hooks/use-api-keys"
import { SyncUnavailable } from "@/components/common/sync-unavailable"
import { retryOrgCollections } from "@/lib/collections/org-collections"
import { useLiveClock } from "@/hooks/use-live-clock"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { toastExit } from "@/lib/error-toast"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatDateInTimezone } from "@/lib/timezone-format"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { CreateApiKeyDialog } from "./create-api-key-dialog"
import { RollApiKeyDialog } from "./roll-api-key-dialog"

type ApiKey = V2ApiKey

/**
 * A key has exactly one status, and the list is grouped by it. "Expiring" is not a separate bucket —
 * the key still works, so it belongs with the active ones — but it carries a badge and sorts to the
 * top, because an expiry nobody noticed is this page's most common failure.
 */
export type ApiKeyStatus = "active" | "expiring" | "expired" | "revoked"
type ApiKeyView = "active" | "expired" | "revoked"

const EXPIRING_WINDOW_MS = 7 * 86_400_000

/** `now` is passed in so every row in a render agrees on where the expiry boundary falls. */
export function apiKeyStatus(apiKey: ApiKey, now: number): ApiKeyStatus {
	if (apiKey.revoked) return "revoked"
	const expiresAt = apiKey.expires_at === null ? null : Date.parse(apiKey.expires_at)
	if (expiresAt === null || !Number.isFinite(expiresAt)) return "active"
	if (expiresAt <= now) return "expired"
	return expiresAt - now < EXPIRING_WINDOW_MS ? "expiring" : "active"
}

/**
 * Whether any key's status can still change on the wall clock alone — it has an expiry ahead of it,
 * so it will cross into the last-week window or past the expiry itself while the page is open. When
 * nothing can, the live clock never schedules a timer.
 */
function hasPendingStatusBoundary(keys: ReadonlyArray<ApiKey>, now: number): boolean {
	return keys.some((apiKey) => {
		if (apiKey.revoked || apiKey.expires_at === null) return false
		const expiresAt = Date.parse(apiKey.expires_at)
		return Number.isFinite(expiresAt) && expiresAt > now
	})
}

function matchesSearch(apiKey: ApiKey, needle: string): boolean {
	const haystack = [apiKey.name, apiKey.description ?? "", apiKey.key_prefix].join(" ").toLowerCase()
	return haystack.includes(needle)
}

const VIEW_LABELS = {
	active: "Active",
	expired: "Expired",
	revoked: "Revoked",
} satisfies Record<ApiKeyView, string>

export function ApiKeysSection() {
	const isAdmin = useIsOrgAdmin()
	const [view, setView] = useState<ApiKeyView>("active")
	const [search, setSearch] = useState("")
	const [createOpen, setCreateOpen] = useState(false)
	const [revokeOpen, setRevokeOpen] = useState(false)
	const [revokingKey, setRevokingKey] = useState<ApiKey | null>(null)
	const [rollOpen, setRollOpen] = useState(false)
	const [rollingKey, setRollingKey] = useState<ApiKey | null>(null)

	const { keys, isLoading, isError } = useApiKeysList()
	const { prepareForMutation, reconcileTxid } = useApiKeyMutationSync()
	const revokeMutation = useAtomSet(MapleApiV2AtomClient.mutation("apiKeys", "revoke"), {
		mode: "promiseExit",
	})

	function openRevokeDialog(key: ApiKey) {
		setRevokingKey(key)
		setRevokeOpen(true)
	}

	function openRollDialog(key: ApiKey) {
		setRollingKey(key)
		setRollOpen(true)
	}

	async function handleRevoke(): Promise<boolean> {
		if (!revokingKey) return false
		prepareForMutation()
		const result = await revokeMutation({ params: { id: revokingKey.id } })
		// ConfirmDialog closes on `true` (`revokingKey` stays set so the copy doesn't swap mid-animation);
		// `false` keeps it open so the user can retry.
		const ok = toastExit(result, { success: "API key revoked", error: "Failed to revoke API key" })
		if (Exit.isSuccess(result)) void reconcileTxid(result.value.txid)
		return ok
	}

	// One pass, one clock. An expired key used to count as "Active" and sit in the active list behind
	// a badge that only appeared on wide viewports, so the tab counts told you a key still worked
	// when it did not.
	//
	// The clock has to advance, not just be read once: the key collection only emits when its rows
	// change, so a key that expires while this page is open would otherwise sit in Active behind a
	// status frozen at the last render. The timer stops itself once no key has an expiry left.
	const now = useLiveClock({ enabled: hasPendingStatusBoundary(keys, Date.now()) })
	const statuses = new Map(keys.map((k) => [k.id, apiKeyStatus(k, now)] as const))
	const statusOf = (k: ApiKey): ApiKeyStatus => statuses.get(k.id) ?? "active"

	const buckets = {
		active: keys.filter((k) => statusOf(k) === "active" || statusOf(k) === "expiring"),
		expired: keys.filter((k) => statusOf(k) === "expired"),
		revoked: keys.filter((k) => statusOf(k) === "revoked"),
	} satisfies Record<ApiKeyView, ReadonlyArray<ApiKey>>

	// A tab can empty out under you — revoking the last expired key, say. Fall back rather than
	// leaving the page on a tab that no longer exists.
	const activeView: ApiKeyView = buckets[view].length > 0 ? view : "active"

	const mcpCount = buckets.active.filter((k) => k.kind === "mcp").length
	const standardCount = buckets.active.length - mcpCount

	const needle = search.trim().toLowerCase()
	const visibleKeys = [...buckets[activeView]]
		.filter((k) => needle.length === 0 || matchesSearch(k, needle))
		// Keys about to stop working lead the list; everything else keeps collection order.
		.sort((a, b) => Number(statusOf(b) === "expiring") - Number(statusOf(a) === "expiring"))

	// A filter that is applied must stay clearable. Switching from a big bucket to a small one used
	// to hide the input while its text kept filtering, stranding the list on "No keys match".
	const showSearch = buckets[activeView].length > 5 || needle.length > 0

	return (
		<SettingsSections>
			<SettingsSection
				title="API keys"
				framed={false}
				actions={
					<Button onClick={() => setCreateOpen(true)} size="sm" disabled={!isAdmin}>
						<PlusIcon data-icon="inline-start" />
						Create key
					</Button>
				}
			>
				{keys.length > 0 || showSearch ? (
					<div className="flex flex-wrap items-center gap-3">
						{keys.length > 0 && (
							<>
								<SegmentedSelect
									size="sm"
									aria-label="Key status"
									value={activeView}
									onChange={setView}
									options={(["active", "expired", "revoked"] as const)
										// A tab for an empty bucket is a dead end. Active always shows, so
										// there is something to fall back to.
										.filter((tab) => tab === "active" || buckets[tab].length > 0)
										.map((tab) => ({
											value: tab,
											label: `${VIEW_LABELS[tab]} · ${buckets[tab].length}`,
										}))}
								/>
								{buckets.active.length > 0 && (
									<span className="text-muted-foreground font-mono text-2xs">
										<span className="text-success-foreground">
											{standardCount} standard
										</span>
										<span className="text-muted-foreground/40"> · </span>
										<span className="text-info-foreground">{mcpCount} mcp</span>
									</span>
								)}
							</>
						)}
						<div className="flex-1" />
						{showSearch && (
							<SearchInput
								value={search}
								onValueChange={setSearch}
								placeholder="Filter by name or prefix"
								className="w-56"
							/>
						)}
					</div>
				) : null}

				<Panel>
					{isLoading ? (
						<SkeletonList rows={2} rowClassName="h-[52px]" gap="2" className="p-4" />
					) : isError ? (
						<SyncUnavailable
							title="Couldn't load API keys"
							description="The key list couldn't be synced. Your keys are unaffected; this is a read problem."
							onRetry={retryOrgCollections}
						/>
					) : keys.length === 0 ? (
						<Empty className="py-8">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<KeyIcon size={16} />
								</EmptyMedia>
								<EmptyTitle>No API keys</EmptyTitle>
								<EmptyDescription>
									Create an API key to authenticate with the Maple API and MCP server.
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<EmptyActions>
									{isAdmin ? (
										<Button size="sm" onClick={() => setCreateOpen(true)}>
											<PlusIcon data-icon="inline-start" />
											Create key
										</Button>
									) : (
										<span className="text-muted-foreground text-sm">
											Only org admins can create API keys.
										</span>
									)}
									<DocsLink page="authentication" />
								</EmptyActions>
							</EmptyContent>
						</Empty>
					) : visibleKeys.length === 0 ? (
						<Empty className="py-8">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<KeyIcon size={16} />
								</EmptyMedia>
								<EmptyTitle>
									{needle.length > 0
										? "No keys match"
										: `No ${VIEW_LABELS[activeView].toLowerCase()} keys`}
								</EmptyTitle>
								<EmptyDescription>
									{needle.length > 0
										? `Nothing in ${VIEW_LABELS[activeView]} matches "${search.trim()}".`
										: activeView === "active"
											? "Every key has expired or been revoked. Create a new key to keep integrations working."
											: "Keys show up here once they reach this state."}
								</EmptyDescription>
							</EmptyHeader>
							{needle.length === 0 && activeView === "active" && isAdmin && (
								<EmptyContent>
									<Button size="sm" onClick={() => setCreateOpen(true)}>
										<PlusIcon data-icon="inline-start" />
										Create key
									</Button>
								</EmptyContent>
							)}
						</Empty>
					) : (
						// The card frame replaces DataTable's own top/bottom rule.
						<DataTable.Root
							ariaLabel="API keys"
							stickySurfaceClass="bg-card"
							className="border-y-0"
						>
							<DataTable.Head>
								<ColumnHead label="Key" width="min-w-0 flex-1" />
								<ColumnHead label="Prefix" width={COL.prefix} />
								<ColumnHead label="Scopes" width={COL.scopes} />
								<ColumnHead label="Last used" width={COL.lastUsed} />
								<ColumnHead label="Expires" width={COL.expires} />
								<span className={COL.menu} />
							</DataTable.Head>
							{visibleKeys.map((key) => (
								<ApiKeyRow
									key={key.id}
									apiKey={key}
									status={statusOf(key)}
									now={now}
									onRoll={key.revoked ? undefined : () => openRollDialog(key)}
									onRevoke={key.revoked ? undefined : () => openRevokeDialog(key)}
								/>
							))}
						</DataTable.Root>
					)}
				</Panel>
			</SettingsSection>

			{!isAdmin ? (
				<p className="text-muted-foreground text-xs">
					Only org admins can create API keys. For a key that connects your editor to Maple, use the{" "}
					<Link
						to="/mcp"
						className="text-foreground underline underline-offset-2 hover:no-underline"
					>
						MCP
					</Link>{" "}
					page; you can create one of those yourself.
				</p>
			) : null}

			<ApiReference />

			<CreateApiKeyDialog open={createOpen} onOpenChange={setCreateOpen} />

			<RollApiKeyDialog open={rollOpen} onOpenChange={setRollOpen} apiKey={rollingKey} />

			<ConfirmDialog
				open={revokeOpen}
				onOpenChange={setRevokeOpen}
				title="Revoke API key?"
				description={
					revokingKey ? (
						<>
							<span className="text-foreground font-medium">{revokingKey.name}</span> (
							<span className="font-mono text-xs">{revokingKey.key_prefix}</span>) will stop
							working immediately. This action cannot be undone.
						</>
					) : (
						<>
							This action cannot be undone. Any integrations using this key will stop working
							immediately.
						</>
					)
				}
				confirmLabel="Revoke key"
				onConfirm={handleRevoke}
			/>
		</SettingsSections>
	)
}

/**
 * Keep in sync with `SCOPE_FAMILIES` in create-api-key-dialog.tsx — one row per
 * shipped v2 resource family.
 */
const SCOPE_FAMILY_ROWS = [
	{ id: "api_keys", label: "API keys", description: "Create, roll, and revoke API keys" },
	{ id: "dashboards", label: "Dashboards", description: "Dashboards, templates, and version history" },
	{
		id: "alerts",
		label: "Alerts",
		description: "Alert rules (incl. test/preview/checks), destinations, and incidents",
	},
	{ id: "ingest_keys", label: "Ingest keys", description: "View and roll telemetry ingest keys" },
	{
		id: "attribute_mappings",
		label: "Attribute mappings",
		description: "Ingest-time attribute rewrite rules",
	},
	{
		id: "scrape_targets",
		label: "Scrape targets",
		description: "Prometheus/PlanetScale scrape targets, probes, and checks",
	},
	{ id: "instrumentation", label: "Recommendations", description: "Instrumentation recommendations" },
	{
		id: "investigations",
		label: "Investigations",
		description: "AI investigation war-rooms: list, open, and update status",
	},
	{
		id: "anomalies",
		label: "Anomalies",
		description: "Anomaly incidents (incl. timeseries/resolve/link-issue) and detector settings",
	},
	{
		id: "session_replays",
		label: "Session replays",
		description: "Search sessions, retrieve detail, events, and transcripts",
	},
	{ id: "traces", label: "Traces", description: "Search traces and retrieve spans" },
	{ id: "logs", label: "Logs", description: "Search and retrieve log records" },
	{ id: "metrics", label: "Metrics", description: "Metric catalog and timeseries reads" },
	{ id: "services", label: "Services", description: "Service catalog and health summaries" },
	{ id: "service_map", label: "Service map", description: "Service-to-service topology" },
	{ id: "query", label: "Query", description: "Structured telemetry queries" },
	{ id: "organization", label: "Organization", description: "Read the organization's identity" },
	{ id: "audit_log", label: "Audit log", description: "Read the audit log (org admins only)" },
] as const

const docsUrl = `${apiBaseUrl}/v2/docs`

const curlExample = `curl ${apiBaseUrl}/v2/alerts/rules \\
  -H "Authorization: Bearer maple_ak_..."`

/**
 * The reference for the keys listed above: where to point them, and what each scope in the create
 * dialog actually grants. It used to be its own "API Reference" nav item, which split one job across
 * two tabs — you cannot read the scope table and pick scopes at the same time.
 */
function ApiReference() {
	return (
		<>
			<SettingsSection
				title="API reference"
				description="The Maple v2 API is a resource-oriented REST interface: snake_case JSON, prefixed object IDs, cursor-paginated lists, and scoped API keys."
				actions={
					<Button
						size="sm"
						variant="outline"
						render={<a href={docsUrl} target="_blank" rel="noopener noreferrer" />}
					>
						<CodeIcon data-icon="inline-start" />
						Open API reference
					</Button>
				}
			>
				<div className="space-y-4">
					<CopyableField label="Base URL" value={`${apiBaseUrl}/v2`} />
					<div className="space-y-1">
						<span className="text-xs text-muted-foreground">Quick start</span>
						<Panel tone="muted" className="flex-row items-start justify-between gap-2 px-3 py-2">
							<pre className="min-w-0 flex-1 overflow-x-auto font-mono text-sm leading-6">
								{curlExample}
							</pre>
							<CopyButton value={curlExample} label="curl example" size="icon-sm" />
						</Panel>
					</div>
				</div>
			</SettingsSection>

			<SettingsSection
				title="Scopes"
				description={
					<>
						Restricted keys grant <InlineCode>read</InlineCode> or <InlineCode>write</InlineCode>{" "}
						access per resource family (<InlineCode>write</InlineCode> implies{" "}
						<InlineCode>read</InlineCode>). A key without scopes has full access.
					</>
				}
				padded={false}
			>
				<div className="divide-y">
					{SCOPE_FAMILY_ROWS.map((family) => (
						<div
							key={family.id}
							className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-2.5"
						>
							<div className="min-w-0 flex-1 space-y-0.5">
								<div className="text-sm font-medium">{family.label}</div>
								<TruncatedText className="text-xs text-muted-foreground">
									{family.description}
								</TruncatedText>
							</div>
							<div className="flex shrink-0 basis-full items-center gap-1.5 sm:basis-auto">
								<Badge variant="outline" mono className="text-2xs">
									{family.id}:read
								</Badge>
								<Badge variant="outline" mono className="text-2xs">
									{family.id}:write
								</Badge>
							</div>
						</div>
					))}
				</div>
			</SettingsSection>
		</>
	)
}

// Shared column lanes so the header row and key rows stay aligned. Prefix/scopes/last-used
// collapse on narrower viewports; the key cell always keeps name + created meta visible.
const COL = {
	prefix: "hidden w-[120px] shrink-0 lg:block",
	scopes: "hidden w-[180px] shrink-0 xl:block",
	lastUsed: "hidden w-[90px] shrink-0 xl:block",
	expires: "hidden w-[110px] shrink-0 md:block",
	menu: "w-7 shrink-0",
}

/** "in 3 days" / "today" — the urgency, not the date. The Expires column carries the date. */
function expiresInLabel(expiresAt: number, now: number): string {
	const days = Math.floor((expiresAt - now) / 86_400_000)
	if (days < 1) return "Expires today"
	return `Expires in ${countLabel(days, "day")}`
}

function ApiKeyRow({
	apiKey,
	status,
	now,
	onRoll,
	onRevoke,
}: {
	apiKey: ApiKey
	status: ApiKeyStatus
	/** The same clock the status was derived from, so the badge cannot disagree with the bucket. */
	now: number
	onRoll?: () => void
	onRevoke?: () => void
}) {
	const isMcp = apiKey.kind === "mcp"
	const Icon = isMcp ? SquareTerminalIcon : KeyIcon
	const expiresAt = apiKey.expires_at === null ? null : Date.parse(apiKey.expires_at)
	const expiresInPast = status === "expired"
	const expiresSoon = status === "expiring"

	// Type-coded icon tile: emerald for standard keys (live credential), blue for MCP
	// (agent/machine type). Dead keys — revoked or expired — desaturate to neutral.
	const tileClass =
		status === "revoked" || status === "expired"
			? "bg-muted/40 text-muted-foreground"
			: isMcp
				? "bg-info/10 text-info"
				: "bg-success/10 text-success"

	const { effectiveTimezone } = useTimezonePreference()
	const formatDate = (timestamp: string) => formatDateInTimezone(timestamp, { timeZone: effectiveTimezone })
	const createdMeta = [
		apiKey.description,
		`Created ${formatDate(apiKey.created_at)}${apiKey.created_by_email ? ` by ${apiKey.created_by_email}` : ""}`,
	]
		.filter(Boolean)
		.join(" · ")

	return (
		<div
			className={cn(
				"flex items-center gap-4 border-b border-border/40 px-4 py-3 transition-colors last:border-0",
				status === "revoked" || status === "expired" ? "opacity-60" : "hover:bg-muted/20",
			)}
		>
			<div className="flex min-w-0 flex-1 items-center gap-2.5">
				<div className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", tileClass)}>
					<Icon size={13} />
				</div>
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-1.5">
						<TruncatedText
							text={apiKey.name}
							className="text-foreground text-sm font-medium leading-none"
						/>
						{isMcp && (
							<Badge variant="info" size="sm">
								MCP
							</Badge>
						)}
						{status === "revoked" && (
							<Badge variant="crit" size="sm">
								Revoked
							</Badge>
						)}
						{expiresInPast && (
							<Badge variant="outline" size="sm">
								Expired
							</Badge>
						)}
						{/* The Expires column is hidden below `md`, so the one state that silently
						    breaks a running integration rides in the name row instead. */}
						{expiresSoon && expiresAt !== null && (
							<Badge variant="warn" size="sm">
								{expiresInLabel(expiresAt, now)}
							</Badge>
						)}
					</div>
					<TruncatedText className="text-muted-foreground text-2xs">{createdMeta}</TruncatedText>
				</div>
			</div>

			<InlineCode
				variant="plain"
				className={cn(COL.prefix, "text-foreground/55 truncate text-2xs tracking-tight")}
			>
				{apiKey.key_prefix}
			</InlineCode>

			<div className={cn(COL.scopes)}>
				<ScopesCell apiKey={apiKey} />
			</div>

			<span className={cn(COL.lastUsed, "text-muted-foreground truncate text-2xs")}>
				{apiKey.last_used_at ? (
					<RelativeTime value={apiKey.last_used_at} tooltip="title" />
				) : (
					EMPTY_VALUE
				)}
			</span>

			<span
				className={cn(
					COL.expires,
					"truncate text-2xs",
					expiresSoon ? "text-severity-warn" : "text-muted-foreground",
				)}
			>
				{apiKey.expires_at ? formatDate(apiKey.expires_at) : "Never"}
			</span>

			<div className={cn(COL.menu, "flex items-center justify-end")}>
				{onRevoke && (
					<RowActionsMenu label={`Actions for ${apiKey.name}`}>
						{onRoll && (
							<DropdownMenuItem onClick={onRoll}>
								<ArrowPathIcon />
								Roll key
							</DropdownMenuItem>
						)}
						<DropdownMenuItem variant="destructive" onClick={onRevoke}>
							<TrashIcon />
							Revoke key
						</DropdownMenuItem>
					</RowActionsMenu>
				)}
			</div>
		</div>
	)
}

function ScopesCell({ apiKey }: { apiKey: ApiKey }) {
	if (apiKey.kind === "mcp") {
		return <span className="text-muted-foreground text-2xs">MCP tools</span>
	}
	if (apiKey.scopes === null) {
		return <span className="text-foreground/80 text-2xs">Full access</span>
	}
	const compact = apiKey.scopes.map((scope) => scope.replace(/:write$/, ":w").replace(/:read$/, ":r"))
	const shown = compact.slice(0, 2).join(" · ")
	const extra = compact.length - 2
	return (
		<TruncatedText
			mono
			text={apiKey.scopes.join(", ")}
			className="text-muted-foreground text-2xs tracking-tight"
		>
			{shown}
			{extra > 0 ? ` · +${extra}` : ""}
		</TruncatedText>
	)
}
