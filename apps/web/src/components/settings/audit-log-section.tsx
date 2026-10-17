import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { auditActionLabel, auditResourceLabel } from "@maple/domain/audit-actions"
import type { AuditActorType, AuditLogSource, AuditOutcome } from "@maple/domain/http"
import {
	encodePublicId,
	PublicIdPrefixes,
	type V2AuditChanges,
	type V2AuditLogEntry,
} from "@maple/domain/http/v2"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { Option } from "effect"
import { useState } from "react"

import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { auditLogPageAtom } from "@/lib/services/atoms/audit-log-atoms"

import { Avatar, AvatarFallback, AvatarImage } from "@maple/ui/components/ui/avatar"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { ListFooter } from "@maple/ui/components/ui/list-footer"
import { Panel } from "@maple/ui/components/ui/panel"
import { RefreshButton } from "@maple/ui/components/ui/refresh-button"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { SegmentedSelect } from "@/components/common/segmented-select"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { trySync } from "@maple/ui/lib/try-sync"
import { cn } from "@maple/ui/lib/utils"
import { RelativeTime } from "@/components/common/relative-time"
import { ChevronRightIcon, HistoryIcon } from "@/components/icons"
import { SettingsSection } from "@/components/settings/settings-section"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { ErrorState } from "@/components/common/error-state"
import { initialsFrom } from "@maple/ui/lib/initials"

import { AuditLogDateRange } from "./audit-log-date-range"
import {
	type AuditLogFilters,
	auditLogSearchFrom,
	hasAuditLogFilters,
	parseAuditLogSearch,
	resolveAuditDateRange,
} from "./audit-log-filters"
import { AuditLogPersonFilter } from "./audit-log-person-filter"
import { auditResourceDisplay } from "./audit-log-resource"

type ActorFilter = AuditActorType | "all"
type OutcomeFilter = AuditOutcome | "all"

const ACTOR_FILTERS: ReadonlyArray<{ value: ActorFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "user", label: "Users" },
	{ value: "api_key", label: "API keys" },
	{ value: "agent", label: "Agents" },
	{ value: "system", label: "System" },
]

const OUTCOME_FILTERS: ReadonlyArray<{ value: OutcomeFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "allowed", label: "Allowed" },
	{ value: "denied", label: "Denied" },
]

const SOURCE_LABELS = {
	dashboard: "Dashboard",
	api: "API",
	mcp: "MCP",
	chat_platform: "Chat",
	system: "System",
} satisfies Record<AuditLogSource, string>

const ACTOR_BADGES = {
	user: { label: "User", variant: "secondary" },
	api_key: { label: "API key", variant: "ok" },
	agent: { label: "Agent", variant: "info" },
	system: { label: "System", variant: "outline" },
} satisfies Record<AuditActorType, { label: string; variant: "secondary" | "ok" | "info" | "outline" }>

// Shared column lanes so the header row and entry rows stay aligned. The panel, not the
// viewport, is what the breakpoints measure: resource, source and outcome fold away as it
// narrows, and below `@md` a row wraps with the action on its own line.
const COL = {
	time: "flex w-22 shrink-0 items-center gap-2",
	actor: "min-w-0 flex-1 @md:w-38 @md:flex-none",
	action: "min-w-0 basis-full pl-5 @md:basis-0 @md:flex-1 @md:pl-0",
	resource: "hidden w-56 min-w-0 shrink-0 @3xl:block",
	source: "hidden w-20 shrink-0 @2xl:block",
	outcome: "hidden w-15 shrink-0 @md:block",
}

/**
 * Up to two initials from a display name, for the moment before the avatar
 * loads and for the members Clerk serves no picture for.
 */
function initialsOf(label: string): string {
	// A row we could not name falls back to the raw `user_…` id; "U" would read
	// as a name it is not.
	if (label.startsWith("user_")) return "?"
	return initialsFrom(label)
}

/**
 * `user_3BfcmIS3bUNV6BfAEkR2WzFOCvu` → `user_…FOCvu`. The prefix says what kind
 * of id it is and the tail is what someone compares against a copied value;
 * the middle is noise in a narrow lane. The full id stays in the detail panel.
 */
function abbreviateId(id: string): string {
	const prefixEnd = id.indexOf("_")
	if (prefixEnd === -1 || id.length <= prefixEnd + 10) return id
	return `${id.slice(0, prefixEnd + 1)}…${id.slice(-5)}`
}

function actorDisplayName(entry: V2AuditLogEntry): string | null {
	if (entry.actor_name !== null) return entry.actor_name
	if (entry.actor_id !== null) return abbreviateId(entry.actor_id)
	return null
}

/** `<redacted>` / `<updated>` are the audit pipeline's placeholders, not values. */
function isPlaceholder(value: unknown): value is string {
	return typeof value === "string" && /^<[a-z]+>$/.test(value)
}

// JSON.stringify(undefined) is undefined; surface it as text.
function formatScalar(value: unknown): string {
	if (typeof value === "string") return value
	return JSON.stringify(value) ?? "undefined"
}

/** What a metadata string that opens with `{` or `[` parses to, when it parses at all. */
type JsonDocument = Record<string, unknown> | ReadonlyArray<unknown>

/**
 * Metadata values are stored as they were recorded: request bodies and tool
 * parameters arrive as JSON text, SQL as a statement. Anything structured, or
 * long enough to wrap, is rendered as a block rather than inline.
 */
function metadataBlock(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim()
		const parsed =
			trimmed.startsWith("{") || trimmed.startsWith("[")
				? Option.getOrNull(trySync((): JsonDocument => JSON.parse(trimmed)))
				: null
		if (parsed !== null) return JSON.stringify(parsed, null, 2)
		return value.length > 72 || value.includes("\n") ? value : null
	}
	if (value !== null && typeof value === "object") return JSON.stringify(value, null, 2)
	return null
}

/**
 * Append the next page, dropping any entry already shown. The pinned `until`
 * ceiling makes overlap rare, but a filter re-fetch or a refresh mid-scroll can
 * still repeat one, and a duplicated React key corrupts the list either way.
 */
function dedupeById(
	existing: ReadonlyArray<V2AuditLogEntry>,
	next: ReadonlyArray<V2AuditLogEntry>,
): V2AuditLogEntry[] {
	const seen = new Set(existing.map((entry) => entry.id))
	return [...existing, ...next.filter((entry) => !seen.has(entry.id))]
}

interface AuditLogView {
	source: { data: ReadonlyArray<V2AuditLogEntry> }
	entries: V2AuditLogEntry[]
	hasMore: boolean
	nextCursor: string | null
}

export function AuditLogSection() {
	const search = useSearch({ from: "/settings" })
	const navigate = useNavigate({ from: "/settings" })
	const filters = parseAuditLogSearch(search)

	// Rolling presets resolve against the moment they were picked (or refreshed), so the
	// page atom's key stays stable instead of moving with the clock on every render.
	const [resolvedAt, setResolvedAt] = useState(() => Date.now())
	const bounds = resolveAuditDateRange(filters.range, resolvedAt)

	const filterInput = {
		...(filters.actorType !== undefined ? { actorType: filters.actorType } : undefined),
		...(filters.actorId !== undefined ? { actorId: filters.actorId } : undefined),
		...(filters.outcome !== undefined ? { outcome: filters.outcome } : undefined),
		...(bounds.since !== undefined ? { since: bounds.since } : undefined),
		...(bounds.until !== undefined ? { until: bounds.until } : undefined),
	}

	const [cursor, setCursor] = useState<string | undefined>(undefined)
	// Frozen on the first Load more, and cleared whenever the list restarts. The
	// log is append-only and paginated by offset, so entries written mid-scroll
	// would otherwise shift later pages and make them repeat and skip rows.
	const [pinnedUntil, setPinnedUntil] = useState<string | undefined>(undefined)

	// A filter change (from the toolbar, a shared link or back/forward) restarts the list.
	const listKey = JSON.stringify(filterInput)
	const [shownKey, setShownKey] = useState(listKey)
	if (shownKey !== listKey) {
		setShownKey(listKey)
		setCursor(undefined)
		setPinnedUntil(undefined)
	}

	const pageAtom = auditLogPageAtom({
		...filterInput,
		...(cursor !== undefined ? { cursor } : undefined),
		...(pinnedUntil !== undefined ? { until: pinnedUntil } : undefined),
	})
	// The first page for the current filters: what Refresh re-fetches. Without
	// the refresh the page family would hand back its cached copy from before.
	const firstPageAtom = auditLogPageAtom(filterInput)
	const pageResult = useAtomValue(pageAtom)
	const refreshPage = useAtomRefresh(pageAtom)
	const refreshFirstPage = useAtomRefresh(firstPageAtom)

	// Each Load more / filter change swaps to a new page atom, which starts in its
	// initial state. Keep the accumulated entries so the table stays rendered
	// (dimmed) while the next page loads; a fresh (cursor-less) page replaces them.
	const [view, setView] = useState<AuditLogView | null>(null)
	if (Result.isSuccess(pageResult) && view?.source !== pageResult.value) {
		setView({
			source: pageResult.value,
			entries:
				cursor === undefined
					? [...pageResult.value.data]
					: dedupeById(view?.entries ?? [], pageResult.value.data),
			hasMore: pageResult.value.has_more,
			nextCursor: pageResult.value.next_cursor,
		})
	}

	function setFilters(next: AuditLogFilters) {
		setResolvedAt(Date.now())
		void navigate({ search: (prev) => ({ ...prev, ...auditLogSearchFrom(next) }), replace: true })
	}

	function handleRefresh() {
		setCursor(undefined)
		setPinnedUntil(undefined)
		// A rolling window moves forward on refresh; a fixed one re-fetches as is.
		if (filters.range.kind === "preset") setResolvedAt(Date.now())
		else refreshFirstPage()
	}

	// A failed page is settled, not loading: dimming the list and spinning the footer
	// on it would never end. Only a retry (which sets `waiting`) puts it back in flight.
	const failed = Result.isFailure(pageResult)
	const waiting = failed ? pageResult.waiting : !Result.isSuccess(pageResult) || pageResult.waiting
	const filtered = hasAuditLogFilters(filters)

	return (
		<SettingsSection
			title="Audit log"
			description="Every change, refused attempt and data read from the dashboard, API, MCP and chat. Select an entry for its full record."
			framed={false}
			width="wide"
		>
			<div className="flex flex-col gap-2">
				<div className="flex flex-wrap items-center gap-2">
					<AuditLogDateRange
						value={filters.range}
						onChange={(range) => setFilters({ ...filters, range })}
					/>
					<AuditLogPersonFilter
						value={filters.actorId}
						onChange={(actorId) => setFilters({ ...filters, actorId })}
					/>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<SegmentedSelect
						size="sm"
						aria-label="Actor type"
						value={filters.actorType ?? "all"}
						onChange={(value: ActorFilter) =>
							setFilters({ ...filters, actorType: value === "all" ? undefined : value })
						}
						options={ACTOR_FILTERS}
					/>
					<SegmentedSelect
						size="sm"
						aria-label="Outcome"
						value={filters.outcome ?? "all"}
						onChange={(value: OutcomeFilter) =>
							setFilters({ ...filters, outcome: value === "all" ? undefined : value })
						}
						options={OUTCOME_FILTERS}
					/>
					<div className="flex-1" />
					<RefreshButton
						iconOnly
						variant="ghost"
						label="Refresh audit log"
						pending={waiting}
						onRefresh={handleRefresh}
					/>
				</div>
			</div>

			<Panel
				aria-busy={waiting}
				className={cn("@container", refreshingClass(waiting && view !== null))}
			>
				{view === null && Result.isFailure(pageResult) ? (
					<ErrorState
						error={pageResult.cause}
						title="Couldn't load the audit log"
						onRetry={() => refreshPage()}
						className="border-0"
					/>
				) : view === null ? (
					<SkeletonList rows={3} rowClassName="h-[44px]" gap="2" className="p-4" />
				) : view.entries.length === 0 && filtered ? (
					<Empty className="py-8">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HistoryIcon size={16} />
							</EmptyMedia>
							<EmptyTitle>No entries match these filters</EmptyTitle>
							<EmptyDescription>
								Nothing recorded for this range, person, actor type and outcome.
							</EmptyDescription>
						</EmptyHeader>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setFilters({ range: { kind: "all" } })}
						>
							Clear filters
						</Button>
					</Empty>
				) : view.entries.length === 0 ? (
					<Empty className="py-8">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HistoryIcon size={16} />
							</EmptyMedia>
							<EmptyTitle>No audit log entries</EmptyTitle>
							<EmptyDescription>
								Actions and data reads by users, API keys, and agents will appear here.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<div className="divide-border divide-y">
						<div className="hidden items-center gap-3 px-4 py-2 @md:flex" aria-hidden="true">
							<Eyebrow variant="mono" className={COL.time}>
								{/* Holds the chevron's lane so "Time" sits over the timestamps. */}
								<span className="w-3 shrink-0" />
								Time
							</Eyebrow>
							<Eyebrow variant="mono" className={COL.actor}>
								Actor
							</Eyebrow>
							<Eyebrow variant="mono" className={COL.action}>
								Action
							</Eyebrow>
							<Eyebrow variant="mono" className={COL.resource}>
								Resource
							</Eyebrow>
							<Eyebrow variant="mono" className={COL.source}>
								Source
							</Eyebrow>
							<Eyebrow variant="mono" className={COL.outcome}>
								Outcome
							</Eyebrow>
						</div>
						{view.entries.map((entry) => (
							<AuditLogRow key={entry.id} entry={entry} />
						))}
					</div>
				)}
			</Panel>

			{view !== null && failed && (
				<ErrorState
					variant="row"
					error={pageResult.cause}
					title={
						cursor === undefined ? "Couldn't refresh the audit log" : "Couldn't load more entries"
					}
					onRetry={() => refreshPage()}
				/>
			)}

			{view !== null && !failed && view.hasMore && view.nextCursor !== null && (
				<ListFooter
					shown={view.entries.length}
					noun="entries"
					hasMore
					loading={waiting}
					align="start"
					className="justify-start p-0"
					onLoadMore={() => {
						if (view.nextCursor === null) return
						// Pin the window to the newest entry already on screen before
						// the first Load more, so later offsets address a list that
						// cannot grow underneath them.
						if (pinnedUntil === undefined) {
							const newest = view.entries[0]
							if (newest !== undefined) setPinnedUntil(newest.occurred_at)
						}
						setCursor(view.nextCursor)
					}}
				/>
			)}
		</SettingsSection>
	)
}

function ActorCell({ entry }: { entry: V2AuditLogEntry }) {
	const badge = ACTOR_BADGES[entry.actor_type]
	const name = actorDisplayName(entry)

	return (
		<div className={cn(COL.actor, "flex items-center gap-1.5")}>
			{/* A person is shown as a face; keys, agents and system entries keep their badge.
			    The face is never lent to a key or an agent, which carry the minting user's id. */}
			{entry.actor_type === "user" ? (
				<Avatar className="size-4 shrink-0 text-4xs">
					{entry.actor_avatar_url !== null && <AvatarImage src={entry.actor_avatar_url} alt="" />}
					<AvatarFallback>{initialsOf(entry.actor_name ?? entry.actor_id ?? "")}</AvatarFallback>
				</Avatar>
			) : (
				<Badge variant={badge.variant} size="sm" className="shrink-0">
					{badge.label}
				</Badge>
			)}
			{name !== null && (
				<TruncatedText
					text={
						entry.actor_name !== null && entry.actor_id !== null
							? `${name} (${entry.actor_id})`
							: (entry.actor_id ?? name)
					}
					className={cn("text-xs", entry.actor_name === null && "text-muted-foreground")}
				>
					{name}
				</TruncatedText>
			)}
		</div>
	)
}

/** The readable sentence, with the raw `<resource>.<verb>` kept beneath it for search and support. */
function ActionLabel({ action }: { action: string }) {
	const label = auditActionLabel(action)
	if (label === null) return <TruncatedText mono text={action} className="text-xs" />
	return (
		<>
			<TruncatedText text={label} className="text-xs text-foreground" />
			<TruncatedText mono text={action} className="text-3xs text-muted-foreground" />
		</>
	)
}

function DeniedBadge() {
	return (
		<Badge variant="crit" size="sm" className="shrink-0">
			Denied
		</Badge>
	)
}

function AuditLogRow({ entry }: { entry: V2AuditLogEntry }) {
	const [expanded, setExpanded] = useState(false)
	const detailId = `audit-entry-${entry.id}`
	const denied = entry.outcome === "denied"
	const label = auditActionLabel(entry.action) ?? entry.action

	return (
		<div className={cn(expanded && "bg-muted/10")}>
			<div className="hover:bg-muted/20 relative flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 transition-colors @md:flex-nowrap">
				{/* The whole row toggles the detail; the resource link sits above this layer. */}
				<button
					type="button"
					aria-expanded={expanded}
					aria-controls={detailId}
					aria-label={`${expanded ? "Hide" : "Show"} details: ${label}`}
					onClick={() => setExpanded((open) => !open)}
					className="focus-visible:ring-ring absolute inset-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset"
				/>
				<span className={cn(COL.time, "text-muted-foreground text-xs")}>
					<ChevronRightIcon
						size={12}
						className={cn(
							"text-muted-foreground/60 shrink-0 transition-transform",
							expanded && "rotate-90",
						)}
					/>
					<RelativeTime value={entry.occurred_at} tooltip="title" />
				</span>
				<ActorCell entry={entry} />
				<div className={cn(COL.action, "flex min-w-0 flex-col")}>
					<div className="flex min-w-0 items-center gap-1.5">
						<div className="flex min-w-0 flex-col">
							<ActionLabel action={entry.action} />
						</div>
						{denied && (
							<span className="@md:hidden">
								<DeniedBadge />
							</span>
						)}
					</div>
					{denied && entry.denial_reason !== null && (
						<TruncatedText className="text-muted-foreground text-2xs">
							{entry.denial_reason}
						</TruncatedText>
					)}
				</div>
				<div className={COL.resource}>
					<ResourceCell entry={entry} />
				</div>
				<span className={COL.source}>
					<Badge variant="outline" size="sm">
						{SOURCE_LABELS[entry.source]}
					</Badge>
				</span>
				<span className={COL.outcome}>{denied && <DeniedBadge />}</span>
			</div>
			{expanded && (
				<div id={detailId}>
					<AuditLogDetail entry={entry} />
				</div>
			)}
		</div>
	)
}

function ResourceCell({ entry }: { entry: V2AuditLogEntry }) {
	const display = auditResourceDisplay(entry)
	if (display === null) return <span className="text-muted-foreground text-xs">{EMPTY_VALUE}</span>
	if (display.link === null) return <TruncatedText text={display.text} className="text-xs" />
	return (
		<Link
			{...display.link}
			className="relative z-10 block truncate text-xs text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground"
			title={display.text}
		>
			{display.text}
		</Link>
	)
}
/** An identifier with its copy affordance; the one place the full value is shown untruncated. */
function Identifier({ value, label }: { value: string; label: string }) {
	return (
		<span className="inline-flex max-w-full items-center gap-0.5">
			<InlineCode variant="plain" className="truncate text-2xs text-foreground">
				{value}
			</InlineCode>
			<CopyButton value={value} label={label} toast={false} iconSize={12} className="size-5" />
		</span>
	)
}

function ChangeValue({ value }: { value: unknown }) {
	if (isPlaceholder(value)) {
		return <span className="text-muted-foreground/70 italic">{value.slice(1, -1)}</span>
	}
	if (value === undefined || value === null || value === "") {
		return <span className="text-muted-foreground/60">{EMPTY_VALUE}</span>
	}
	return <span className="break-all">{formatScalar(value)}</span>
}

function ChangesTable({ changes }: { changes: V2AuditChanges }) {
	return (
		<Table size="sm" className="font-mono">
			<TableHeader>
				<TableRow>
					<TableHead className="w-[160px] font-normal">Field</TableHead>
					<TableHead className="font-normal">Before</TableHead>
					<TableHead className="font-normal">After</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{changes.fields.map((field) => (
					<TableRow key={field}>
						<TableCell className="text-muted-foreground align-top">{field}</TableCell>
						<TableCell className="align-top whitespace-normal">
							<ChangeValue value={changes.before[field]} />
						</TableCell>
						<TableCell className="align-top whitespace-normal">
							<ChangeValue value={changes.after[field]} />
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	)
}

function MetadataList({ metadata }: { metadata: Record<string, unknown> }) {
	const keys = Object.keys(metadata)
	if (keys.length === 0) return null
	return (
		<KeyValueList layout="grid">
			{keys.map((key) => {
				const value = metadata[key]
				const block = metadataBlock(value)
				return (
					<KeyValue wrap key={key} label={key}>
						{block !== null ? (
							<pre className="bg-background/60 max-h-64 overflow-auto rounded-md border px-2.5 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all">
								{block}
							</pre>
						) : (
							<span className="font-mono text-2xs break-all">
								<ChangeValue value={value} />
							</span>
						)}
					</KeyValue>
				)
			})}
		</KeyValueList>
	)
}

function AuditLogDetail({ entry }: { entry: V2AuditLogEntry }) {
	const badge = ACTOR_BADGES[entry.actor_type]
	const hasChanges = entry.changes !== null && entry.changes.fields.length > 0
	const hasMetadata = entry.metadata !== null && Object.keys(entry.metadata).length > 0
	const { effectiveTimezone } = useTimezonePreference()
	const formatDateTimeFull = (value: string) =>
		formatTimestampInTimezone(value, { timeZone: effectiveTimezone, withYear: true })

	return (
		<div className="border-border/60 space-y-4 border-t px-4 py-3 @md:pl-[44px]">
			<KeyValueList
				layout="grid"
				className="@2xl:grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)_minmax(6rem,max-content)_minmax(0,1fr)] @2xl:gap-x-6"
			>
				<KeyValue wrap label="Occurred">
					<span className="tabular-nums">{formatDateTimeFull(entry.occurred_at)}</span>
				</KeyValue>
				<KeyValue wrap label="Recorded">
					<span className="tabular-nums">{formatDateTimeFull(entry.recorded_at)}</span>
				</KeyValue>
				<KeyValue wrap label="Actor">
					<span className="flex min-w-0 flex-wrap items-center gap-1.5">
						<Badge variant={badge.variant} size="sm">
							{badge.label}
						</Badge>
						{entry.actor_name !== null && <span>{entry.actor_name}</span>}
						{entry.actor_id !== null && <Identifier value={entry.actor_id} label="Actor id" />}
					</span>
				</KeyValue>
				<KeyValue wrap label="Source">
					<span>{SOURCE_LABELS[entry.source]}</span>
					{(entry.origin_ip !== null || entry.origin_country !== null) && (
						<span className="text-muted-foreground">
							{" · "}
							{entry.origin_ip ?? "unknown IP"}
							{entry.origin_country !== null && ` (${entry.origin_country})`}
						</span>
					)}
				</KeyValue>
				<KeyValue wrap label="Action">
					<span className="flex flex-wrap items-center gap-1.5">
						{auditActionLabel(entry.action) !== null && (
							<span>{auditActionLabel(entry.action)}</span>
						)}
						<InlineCode variant="plain" className="text-2xs text-foreground">
							{entry.action}
						</InlineCode>
						{entry.outcome === "denied" ? (
							<Badge variant="crit" size="sm">
								Denied
							</Badge>
						) : (
							<Badge variant="ok" size="sm">
								Allowed
							</Badge>
						)}
					</span>
					{entry.denial_reason !== null && (
						<p className="text-muted-foreground mt-0.5">{entry.denial_reason}</p>
					)}
				</KeyValue>
				<KeyValue wrap label="Resource">
					{entry.resource_type === null && entry.resource_id === null ? (
						<span className="text-muted-foreground/60">{EMPTY_VALUE}</span>
					) : (
						<span className="flex min-w-0 flex-wrap items-center gap-1.5">
							{entry.resource_type !== null && (
								<span>{auditResourceLabel(entry.resource_type) ?? entry.resource_type}</span>
							)}
							{entry.resource_id !== null && (
								<Identifier value={entry.resource_id} label="Resource id" />
							)}
						</span>
					)}
				</KeyValue>
				{entry.affected_user !== null && (
					<KeyValue wrap label="Affected user">
						<Identifier value={entry.affected_user} label="Affected user id" />
					</KeyValue>
				)}
				{entry.request_id !== null && (
					<KeyValue wrap label="Request">
						<Identifier value={entry.request_id} label="Request id" />
					</KeyValue>
				)}
				<KeyValue wrap label="Entry">
					{/* The wire codec hands the client the raw id; show the `alog_…`
					    form the API itself returns, so it can be quoted back to it. */}
					<Identifier
						value={encodePublicId(PublicIdPrefixes.auditLogEntry, entry.id)}
						label="Entry id"
					/>
				</KeyValue>
			</KeyValueList>

			{hasChanges && entry.changes !== null && (
				<section className="space-y-1.5">
					<Eyebrow variant="mono" as="h4">
						Changes
					</Eyebrow>
					<ChangesTable changes={entry.changes} />
				</section>
			)}

			{hasMetadata && entry.metadata !== null && (
				<section className="space-y-1.5">
					<Eyebrow variant="mono" as="h4">
						Details
					</Eyebrow>
					<MetadataList metadata={entry.metadata} />
				</section>
			)}
		</div>
	)
}
