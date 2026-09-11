import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { useAtomSet } from "@/lib/effect-atom"
import { useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Exit } from "effect"
import type { V2ApiKey } from "@maple/domain/http/v2"
import { toastManager } from "@maple/ui/components/ui/toast"
import { cn } from "@maple/ui/lib/utils"

import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
} from "@maple/ui/components/ui/alert-dialog"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
	AlertWarningIcon,
	ArrowPathIcon,
	CodeIcon,
	DotsVerticalIcon,
	KeyIcon,
	PlusIcon,
	SquareTerminalIcon,
	TrashIcon,
} from "@/components/icons"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"
import { useApiKeyMutationSync, useApiKeysList } from "@/hooks/use-api-keys"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { displayError } from "@/lib/error-messages"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { CreateApiKeyDialog } from "./create-api-key-dialog"
import { RollApiKeyDialog } from "./roll-api-key-dialog"

type ApiKey = V2ApiKey

function formatDate(timestamp: string | null): string {
	if (!timestamp) return "Never"
	try {
		return new Date(timestamp).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		})
	} catch {
		return "Unknown"
	}
}

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
	const [isRevoking, setIsRevoking] = useState(false)
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

	async function handleRevoke() {
		if (!revokingKey) return
		setIsRevoking(true)
		prepareForMutation()
		const result = await revokeMutation({ params: { id: revokingKey.id } })
		if (Exit.isSuccess(result)) {
			toastManager.add({ title: "API key revoked", type: "success" })
			void reconcileTxid(result.value.txid)
		} else {
			const { title, message } = displayError(result)
			toastManager.add({ title, description: message, type: "error" })
		}
		setIsRevoking(false)
		setRevokeOpen(false)
		// Keep `revokingKey` set so the dialog copy doesn't swap to the generic
		// fallback while the close animation plays; the next open overwrites it.
	}

	// One pass, one clock. An expired key used to count as "Active" and sit in the active list behind
	// a badge that only appeared on wide viewports, so the tab counts told you a key still worked
	// when it did not.
	const now = Date.now()
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

	const showSearch = buckets[activeView].length > 5

	return (
		<div className="space-y-6">
			<div className="space-y-3">
				<div className="flex flex-wrap items-center gap-3">
					{keys.length > 0 && (
						<>
							<div className="border-border flex items-center gap-0.5 rounded-md border p-0.5">
								{(["active", "expired", "revoked"] as const).map((tab) =>
									// A tab for an empty bucket is a dead end. Active always shows, so
									// there is something to fall back to.
									tab === "active" || buckets[tab].length > 0 ? (
										<FilterTab
											key={tab}
											active={activeView === tab}
											onClick={() => setView(tab)}
										>
											{VIEW_LABELS[tab]} · {buckets[tab].length}
										</FilterTab>
									) : null,
								)}
							</div>
							{buckets.active.length > 0 && (
								<span className="text-muted-foreground font-mono text-[11px]">
									<span className="text-success-foreground">{standardCount} standard</span>
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
					<Button onClick={() => setCreateOpen(true)} size="sm" disabled={!isAdmin}>
						<PlusIcon data-icon="inline-start" size={14} />
						Create key
					</Button>
				</div>

				<div className="bg-card rounded-lg border">
					{isLoading ? (
						<div className="space-y-2 p-4">
							<Skeleton className="h-[52px] w-full" />
							<Skeleton className="h-[52px] w-full" />
						</div>
					) : isError ? (
						<Empty className="py-8">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<AlertWarningIcon size={16} />
								</EmptyMedia>
								<EmptyTitle>Couldn't load API keys</EmptyTitle>
								<EmptyDescription>
									Something went wrong while loading your keys. Reload the page to try
									again.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
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
								<Button size="sm" onClick={() => setCreateOpen(true)} disabled={!isAdmin}>
									<PlusIcon data-icon="inline-start" size={14} />
									Create key
								</Button>
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
										: "Keys show up here once they reach this state."}
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<div className="divide-border divide-y">
							<div className="flex items-center gap-3 px-4 py-2">
								<span className={cn(COL_HEADER, "min-w-0 flex-1")}>Key</span>
								<span className={cn(COL_HEADER, COL.prefix)}>Prefix</span>
								<span className={cn(COL_HEADER, COL.scopes)}>Scopes</span>
								<span className={cn(COL_HEADER, COL.lastUsed)}>Last used</span>
								<span className={cn(COL_HEADER, COL.expires)}>Expires</span>
								<span className={cn(COL.menu)} />
							</div>
							{visibleKeys.map((key) => (
								<ApiKeyRow
									key={key.id}
									apiKey={key}
									status={statusOf(key)}
									onRoll={key.revoked ? undefined : () => openRollDialog(key)}
									onRevoke={key.revoked ? undefined : () => openRevokeDialog(key)}
								/>
							))}
						</div>
					)}
				</div>
			</div>

			{!isAdmin ? (
				<p className="text-muted-foreground text-xs">
					Only org admins can create API keys. For a key that connects your editor to Maple, use the{" "}
					<Link
						to="/mcp"
						className="text-foreground underline underline-offset-2 hover:no-underline"
					>
						MCP
					</Link>{" "}
					page — you can create one of those yourself.
				</p>
			) : null}

			<ApiReference />

			<CreateApiKeyDialog open={createOpen} onOpenChange={setCreateOpen} />

			<RollApiKeyDialog open={rollOpen} onOpenChange={setRollOpen} apiKey={rollingKey} />

			<AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-destructive/10">
							<AlertWarningIcon className="text-destructive" />
						</AlertDialogMedia>
						<AlertDialogTitle>Revoke API key?</AlertDialogTitle>
						<AlertDialogDescription>
							{revokingKey ? (
								<>
									<span className="text-foreground font-medium">{revokingKey.name}</span> (
									<span className="font-mono text-xs">{revokingKey.key_prefix}</span>) will
									stop working immediately. This action cannot be undone.
								</>
							) : (
								<>
									This action cannot be undone. Any integrations using this key will stop
									working immediately.
								</>
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isRevoking}>Cancel</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={handleRevoke} disabled={isRevoking}>
							{isRevoking ? "Revoking..." : "Revoke key"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
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
		description: "AI investigation war-rooms — list, open, and update status",
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
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<div className="flex items-start justify-between gap-4">
						<div className="space-y-1">
							<CardTitle>API Reference</CardTitle>
							<CardDescription>
								The Maple v2 API is a resource-oriented REST interface — snake_case JSON,
								prefixed object IDs, cursor-paginated lists, and scoped API keys.
							</CardDescription>
						</div>
						<Button
							size="sm"
							render={
								<a
									href={docsUrl}
									target="_blank"
									rel="noopener noreferrer"
									aria-label="Open API reference"
								/>
							}
						>
							<CodeIcon data-icon="inline-start" size={14} />
							Open API reference
						</Button>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-1.5">
						<div className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
							Base URL
						</div>
						<div className="bg-muted/50 flex items-center justify-between gap-2 rounded-md border px-3 py-2">
							<code className="font-mono text-sm">{apiBaseUrl}/v2</code>
							<CopyButton value={`${apiBaseUrl}/v2`} label="Base URL" size="icon-sm" />
						</div>
					</div>
					<div className="space-y-1.5">
						<div className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
							Quick start
						</div>
						<div className="bg-muted/50 flex items-start justify-between gap-2 rounded-md border px-3 py-2">
							<pre className="overflow-x-auto font-mono text-sm leading-6">{curlExample}</pre>
							<CopyButton value={curlExample} label="curl example" size="icon-sm" />
						</div>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Scopes</CardTitle>
					<CardDescription>
						Restricted keys grant <code className="font-mono text-xs">read</code> or{" "}
						<code className="font-mono text-xs">write</code> access per resource family (
						<code className="font-mono text-xs">write</code> implies{" "}
						<code className="font-mono text-xs">read</code>). A key without scopes has full
						access.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="divide-y rounded-md border">
						{SCOPE_FAMILY_ROWS.map((family) => (
							<div
								key={family.id}
								className="flex items-center justify-between gap-4 px-3 py-2.5"
							>
								<div className="min-w-0 space-y-0.5">
									<div className="text-sm font-medium">{family.label}</div>
									<div className="text-muted-foreground truncate text-xs">
										{family.description}
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									<Badge variant="outline" className="font-mono text-[11px]">
										{family.id}:read
									</Badge>
									<Badge variant="outline" className="font-mono text-[11px]">
										{family.id}:write
									</Badge>
								</div>
							</div>
						))}
					</div>
				</CardContent>
			</Card>
		</div>
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
const COL_HEADER = "text-muted-foreground/70 font-mono text-[10px] uppercase tracking-[0.12em]"

function FilterTab({
	active,
	onClick,
	children,
}: {
	active: boolean
	onClick: () => void
	children: ReactNode
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rounded px-2.5 py-1 font-mono text-[11px] leading-4 transition-colors",
				active
					? "bg-accent text-foreground font-medium"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	)
}

/** "in 3 days" / "today" — the urgency, not the date. The Expires column carries the date. */
function expiresInLabel(expiresAt: number, now: number): string {
	const days = Math.floor((expiresAt - now) / 86_400_000)
	if (days < 1) return "Expires today"
	return `Expires in ${days} ${days === 1 ? "day" : "days"}`
}

function ApiKeyRow({
	apiKey,
	status,
	onRoll,
	onRevoke,
}: {
	apiKey: ApiKey
	status: ApiKeyStatus
	onRoll?: () => void
	onRevoke?: () => void
}) {
	const isMcp = apiKey.kind === "mcp"
	const Icon = isMcp ? SquareTerminalIcon : KeyIcon
	const relativeLastUsed = apiKey.last_used_at ? formatRelativeTime(apiKey.last_used_at) : null
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

	const createdMeta = [
		apiKey.description,
		`Created ${formatDate(apiKey.created_at)}${apiKey.created_by_email ? ` by ${apiKey.created_by_email}` : ""}`,
	]
		.filter(Boolean)
		.join(" · ")

	return (
		<div
			className={cn(
				"flex items-center gap-3 px-4 py-3 transition-colors",
				status === "revoked" || status === "expired" ? "opacity-60" : "hover:bg-muted/20",
			)}
		>
			<div className="flex min-w-0 flex-1 items-center gap-2.5">
				<div className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", tileClass)}>
					<Icon size={13} />
				</div>
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-1.5">
						<span className="text-foreground truncate text-sm font-medium leading-none">
							{apiKey.name}
						</span>
						{isMcp && (
							<Badge variant="info" size="sm">
								MCP
							</Badge>
						)}
						{status === "revoked" && (
							<Badge variant="error" size="sm">
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
							<Badge variant="warning" size="sm">
								{expiresInLabel(expiresAt, Date.now())}
							</Badge>
						)}
					</div>
					<span className="text-muted-foreground truncate text-[11px]" title={createdMeta}>
						{createdMeta}
					</span>
				</div>
			</div>

			<code
				className={cn(COL.prefix, "text-foreground/55 truncate font-mono text-[11px] tracking-tight")}
			>
				{apiKey.key_prefix}
			</code>

			<div className={cn(COL.scopes)}>
				<ScopesCell apiKey={apiKey} />
			</div>

			<span
				className={cn(COL.lastUsed, "text-muted-foreground truncate text-[11px]")}
				title={apiKey.last_used_at ? formatDate(apiKey.last_used_at) : undefined}
			>
				{apiKey.last_used_at ? (relativeLastUsed ?? formatDate(apiKey.last_used_at)) : "—"}
			</span>

			<span
				className={cn(
					COL.expires,
					"truncate text-[11px]",
					expiresSoon ? "text-warning-foreground" : "text-muted-foreground",
				)}
			>
				{apiKey.expires_at ? formatDate(apiKey.expires_at) : "Never"}
			</span>

			<div className={cn(COL.menu, "flex items-center justify-end")}>
				{onRevoke && (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={<Button variant="ghost" size="icon" className="size-7" />}
							aria-label={`Actions for ${apiKey.name}`}
						>
							<DotsVerticalIcon size={14} />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{onRoll && (
								<DropdownMenuItem onClick={onRoll}>
									<ArrowPathIcon size={14} />
									Roll key
								</DropdownMenuItem>
							)}
							<DropdownMenuItem variant="destructive" onClick={onRevoke}>
								<TrashIcon size={14} />
								Revoke key
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
		</div>
	)
}

function ScopesCell({ apiKey }: { apiKey: ApiKey }) {
	if (apiKey.kind === "mcp") {
		return <span className="text-muted-foreground text-[11px]">MCP tools</span>
	}
	if (apiKey.scopes === null) {
		return <span className="text-foreground/80 text-[11px]">Full access</span>
	}
	const compact = apiKey.scopes.map((scope) => scope.replace(/:write$/, ":w").replace(/:read$/, ":r"))
	const shown = compact.slice(0, 2).join(" · ")
	const extra = compact.length - 2
	return (
		<span
			className="text-muted-foreground block truncate font-mono text-[11px] tracking-tight"
			title={apiKey.scopes.join(", ")}
		>
			{shown}
			{extra > 0 ? ` · +${extra}` : ""}
		</span>
	)
}
