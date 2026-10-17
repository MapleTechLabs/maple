import { useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Exit } from "effect"
import type { ApiKeyKind } from "@maple/domain/http"
import type { V2ApiKey, V2IngestKeys } from "@maple/domain/http/v2"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Alert, AlertAction, AlertDescription } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Panel } from "@maple/ui/components/ui/panel"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { SegmentedSelect } from "@/components/common/segmented-select"
import { ColumnHead, DataTable } from "@/components/common/data-table"
import { RelativeTime } from "@/components/common/relative-time"
import { SyncUnavailable } from "@/components/common/sync-unavailable"
import {
	ArrowPathIcon,
	ArrowRightIcon,
	ChevronDownIcon,
	KeyIcon,
	PlusIcon,
	TrashIcon,
} from "@/components/icons"
import { useApiKeyMutationSync, useApiKeysList } from "@/hooks/use-api-keys"
import { useIsOrgAdmin, useSessionUserId } from "@/hooks/use-is-org-admin"
import { useLiveClock } from "@/hooks/use-live-clock"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { retryOrgCollections } from "@/lib/collections/org-collections"
import { toastExit } from "@/lib/error-toast"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { formatDateInTimezone } from "@/lib/timezone-format"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { AdminOnlyNotice } from "./admin-only-notice"
import { apiKeyRowPermissions } from "./api-key-permissions"
import { ApiReference } from "./api-reference"
import { CreateApiKeyDialog } from "./create-api-key-dialog"
import { IngestKeyValue } from "./ingest-key-value"
import {
	apiKeysFailureDisplay,
	buildKeyRows,
	filterKeyRows,
	hasPendingStatusBoundary,
	KEY_TYPE_LABELS,
	keyAccessSummary,
	type ApiKeyRow,
	type IngestKeyRow,
	type KeyRow,
	type KeyStatusFilter,
	type KeyType,
	type KeyTypeFilter,
} from "./keys-table"
import { RollApiKeyDialog } from "./roll-api-key-dialog"

/** `null` for members: the ingest pair is admin-only, so they never see those rows. */
type IngestKeysState = {
	readonly keys: V2IngestKeys | null
	readonly failed: boolean
	readonly refresh: () => void
} | null

export function ApiKeysSection() {
	const isAdmin = useIsOrgAdmin()
	if (!isAdmin) return <KeysTab ingest={null} />
	return <WithIngestKeys>{(ingest) => <KeysTab ingest={ingest} />}</WithIngestKeys>
}

function WithIngestKeys({ children }: { children: (ingest: NonNullable<IngestKeysState>) => ReactNode }) {
	const queryAtom = retainedQueryV2("ingestKeys", "retrieve", {})
	const result = useAtomValue(queryAtom)
	const refresh = useAtomRefresh(queryAtom)
	const keys = Result.builder(result)
		.onSuccess((v): V2IngestKeys | null => v)
		.orElse(() => null)
	return children({ keys, failed: Result.isFailure(result), refresh })
}

const TYPE_FILTER_LABELS = {
	all: "All",
	ingest: "Ingest",
	api: "API",
	mcp: "MCP",
} satisfies Record<KeyTypeFilter, string>

const STATUS_LABELS = {
	active: "Active",
	expired: "Expired",
	revoked: "Revoked",
} satisfies Record<KeyStatusFilter, string>

const TYPE_BADGE = {
	ingest_public: "info",
	ingest_private: "outline",
	api: "muted",
	mcp: "ok",
} as const satisfies Record<KeyType, "info" | "outline" | "muted" | "ok">

// Shared column lanes so the header and rows stay aligned. Lanes collapse on the table's own width
// (container queries), so they fit the settings column at any viewport. The type badge rides by the name.
const COL = {
	name: "w-0 min-w-[180px] flex-1",
	access: "hidden w-[150px] shrink-0 @xl:block",
	createdBy: "hidden w-[140px] shrink-0 @min-[820px]:block",
	lastUsed: "hidden w-[80px] shrink-0 @2xl:block",
	expires: "w-[100px] shrink-0",
	menu: "w-7 shrink-0",
}

function KeysTab({ ingest }: { ingest: IngestKeysState }) {
	const isAdmin = useIsOrgAdmin()
	const userId = useSessionUserId()
	const [typeFilter, setTypeFilter] = useState<KeyTypeFilter>("all")
	const [statusFilter, setStatusFilter] = useState<KeyStatusFilter>("active")
	const [search, setSearch] = useState("")
	const [createOpen, setCreateOpen] = useState(false)
	const [createKind, setCreateKind] = useState<ApiKeyKind>("standard")
	const [revokeOpen, setRevokeOpen] = useState(false)
	const [revokingKey, setRevokingKey] = useState<V2ApiKey | null>(null)
	const [rollOpen, setRollOpen] = useState(false)
	const [rollingKey, setRollingKey] = useState<V2ApiKey | null>(null)
	const [ingestRollOpen, setIngestRollOpen] = useState(false)
	const [ingestRollType, setIngestRollType] = useState<IngestKeyRow["type"]>("ingest_public")

	const { keys, isLoading, isError } = useApiKeysList()
	const { prepareForMutation, reconcileTxid } = useApiKeyMutationSync()
	const revokeMutation = useAtomSet(MapleApiV2AtomClient.mutation("apiKeys", "revoke"), {
		mode: "promiseExit",
	})
	const rollPublic = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "rollPublic"), {
		mode: "promiseExit",
	})
	const rollPrivate = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "rollPrivate"), {
		mode: "promiseExit",
	})

	// The collection only emits when rows change, so a key expiring while the page is open needs a
	// ticking clock to move buckets. The timer stops once no key has an expiry ahead of it.
	const now = useLiveClock({ enabled: hasPendingStatusBoundary(keys, Date.now()) })
	const rows = buildKeyRows({ apiKeys: keys, ingestKeys: ingest?.keys ?? null, now })
	const { visible, typeCounts, statusCounts } = filterKeyRows(rows, {
		type: typeFilter,
		status: statusFilter,
		search,
	})

	function openCreate(kind: ApiKeyKind) {
		setCreateKind(kind)
		setCreateOpen(true)
	}

	async function handleRevoke(): Promise<boolean> {
		if (!revokingKey) return false
		prepareForMutation()
		const result = await revokeMutation({ params: { id: revokingKey.id } })
		// `true` closes the dialog; `revokingKey` stays set so the copy doesn't swap mid-animation.
		const ok = toastExit(result, { success: "Key revoked", error: "Failed to revoke key" })
		if (Exit.isSuccess(result)) void reconcileTxid(result.value.txid)
		return ok
	}

	const [handleIngestRoll, ingestRolling] = useAsyncAction(async () => {
		const isPublic = ingestRollType === "ingest_public"
		const result = isPublic ? await rollPublic({}) : await rollPrivate({})
		const ok = toastExit(result, {
			success: `${isPublic ? "Public" : "Private"} ingest key rolled. The previous key stopped working immediately.`,
			error: "Unable to roll the ingest key",
		})
		if (ok) ingest?.refresh()
		setIngestRollOpen(false)
	})

	const ingestLoading = ingest !== null && ingest.keys === null && !ingest.failed
	const apiKeysFailure = apiKeysFailureDisplay({ apiKeysFailed: isError, rows })
	const showSkeleton = isLoading || (ingestLoading && keys.length === 0)
	const needle = search.trim()

	return (
		<SettingsSections width="wide">
			{/* Members may still create MCP keys and revoke their own, so the notice names what is admin-only. */}
			<AdminOnlyNotice subject="API keys or ingest keys" />
			<SettingsSection
				title="Keys"
				description="Every credential that sends data to Maple or reads from it."
				framed={false}
				width="wide"
				actions={<CreateKeyButton isAdmin={isAdmin} onCreate={openCreate} />}
			>
				<div className="flex flex-wrap items-center gap-3">
					<SegmentedSelect
						size="sm"
						aria-label="Key type"
						value={typeFilter}
						onChange={setTypeFilter}
						options={(["all", "ingest", "api", "mcp"] as const)
							// Members never see ingest keys, so that chip would always read 0.
							.filter((type) => type !== "ingest" || ingest !== null)
							.map((type) => ({
								value: type,
								label: `${TYPE_FILTER_LABELS[type]} · ${typeCounts[type]}`,
							}))}
					/>
					<Select value={statusFilter} onValueChange={(value) => value && setStatusFilter(value)}>
						<SelectTrigger size="sm" className="w-36" aria-label="Key status">
							<SelectValue>{STATUS_LABELS[statusFilter]}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{(["active", "expired", "revoked"] as const).map((status) => (
								<SelectItem key={status} value={status}>
									{STATUS_LABELS[status]} · {statusCounts[status]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<div className="flex-1" />
					<SearchInput
						value={search}
						onValueChange={setSearch}
						placeholder="Search keys"
						className="w-64"
					/>
				</div>

				{apiKeysFailure === "inline" ? (
					<Alert size="sm" variant="crit">
						<AlertDescription>
							Couldn't load the API and MCP keys. Your keys are unaffected; this is a read
							problem.
						</AlertDescription>
						<AlertAction>
							<Button size="sm" variant="outline" onClick={retryOrgCollections}>
								Retry
							</Button>
						</AlertAction>
					</Alert>
				) : null}

				{ingest?.failed ? (
					<Alert size="sm" variant="crit">
						<AlertDescription>
							Couldn't load the ingest keys. API and MCP keys below are unaffected.
						</AlertDescription>
						<AlertAction>
							<Button size="sm" variant="outline" onClick={ingest.refresh}>
								Retry
							</Button>
						</AlertAction>
					</Alert>
				) : null}

				<Panel>
					{showSkeleton ? (
						<SkeletonList rows={3} rowClassName="h-[52px]" gap="2" className="p-4" />
					) : apiKeysFailure === "replace" ? (
						<SyncUnavailable
							title="Couldn't load keys"
							description="The key list couldn't be synced. Your keys are unaffected; this is a read problem."
							onRetry={retryOrgCollections}
						/>
					) : visible.length === 0 ? (
						<Empty className="py-8">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<KeyIcon size={16} />
								</EmptyMedia>
								<EmptyTitle>
									{needle.length > 0 ? "No keys match" : "No keys here"}
								</EmptyTitle>
								<EmptyDescription>
									{needle.length > 0
										? `Nothing matches "${needle}".`
										: `There are no ${STATUS_LABELS[statusFilter].toLowerCase()} keys of this type.`}
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<KeysTable
							rows={visible}
							now={now}
							viewer={{ isAdmin, userId }}
							onIngestRoll={(type) => {
								setIngestRollType(type)
								setIngestRollOpen(true)
							}}
							onRoll={(key) => {
								setRollingKey(key)
								setRollOpen(true)
							}}
							onRevoke={(key) => {
								setRevokingKey(key)
								setRevokeOpen(true)
							}}
						/>
					)}
				</Panel>
			</SettingsSection>

			<OAuthPointer />

			<ApiReference />

			<CreateApiKeyDialog open={createOpen} onOpenChange={setCreateOpen} kind={createKind} />
			<RollApiKeyDialog open={rollOpen} onOpenChange={setRollOpen} apiKey={rollingKey} />
			<ConfirmDialog
				open={revokeOpen}
				onOpenChange={setRevokeOpen}
				title="Revoke key?"
				description={
					revokingKey ? (
						<>
							<span className="text-foreground font-medium">{revokingKey.name}</span> (
							<span className="font-mono text-xs">{revokingKey.key_prefix}</span>) will stop
							working immediately. This action cannot be undone.
						</>
					) : (
						"Any integrations using this key will stop working immediately. This action cannot be undone."
					)
				}
				confirmLabel="Revoke key"
				onConfirm={handleRevoke}
			/>
			<ConfirmDialog
				open={ingestRollOpen}
				onOpenChange={setIngestRollOpen}
				title={`Roll ${ingestRollType === "ingest_public" ? "public" : "private"} ingest key?`}
				description={
					<>
						This action cannot be undone. Everything sending telemetry with this key will be
						rejected immediately. You will need to update your{" "}
						{ingestRollType === "ingest_public" ? "client-side SDKs" : "server configurations"}{" "}
						with the new key.
					</>
				}
				confirmLabel="Roll key"
				onConfirm={() => void handleIngestRoll()}
				pending={ingestRolling}
			/>
		</SettingsSections>
	)
}

/** Ingest keys are a fixed pair, so only API and MCP keys can be created. Members may create MCP keys. */
function CreateKeyButton({ isAdmin, onCreate }: { isAdmin: boolean; onCreate: (kind: ApiKeyKind) => void }) {
	if (!isAdmin) {
		return (
			<Button size="sm" onClick={() => onCreate("mcp")}>
				<PlusIcon data-icon="inline-start" />
				Create MCP key
			</Button>
		)
	}
	return (
		<div className="flex">
			<Button
				size="sm"
				onClick={() => onCreate("standard")}
				className="relative rounded-r-none before:rounded-r-none focus-visible:z-10"
			>
				<PlusIcon data-icon="inline-start" />
				Create key
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							size="icon-sm"
							aria-label="Choose key type"
							className="relative -ml-px rounded-l-none border-l border-l-primary-foreground/20 before:rounded-l-none focus-visible:z-10"
						/>
					}
				>
					<ChevronDownIcon className="size-3.5" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-40">
					<DropdownMenuItem onClick={() => onCreate("standard")}>API key</DropdownMenuItem>
					<DropdownMenuItem onClick={() => onCreate("mcp")}>MCP key</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	)
}

function KeysTable({
	rows,
	now,
	viewer,
	onIngestRoll,
	onRoll,
	onRevoke,
}: {
	rows: ReadonlyArray<KeyRow>
	now: number
	viewer: { readonly isAdmin: boolean; readonly userId: string | null }
	onIngestRoll: (type: IngestKeyRow["type"]) => void
	onRoll: (key: V2ApiKey) => void
	onRevoke: (key: V2ApiKey) => void
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const formatDate = (timestamp: string) => formatDateInTimezone(timestamp, { timeZone: effectiveTimezone })
	return (
		// The card frame replaces DataTable's own top/bottom rule.
		<DataTable.Root ariaLabel="Keys" stickySurfaceClass="bg-card" className="@container border-y-0">
			<DataTable.Head>
				<ColumnHead label="Name" width={COL.name} />
				<ColumnHead label="Access" width={COL.access} />
				<ColumnHead label="Created by" width={COL.createdBy} />
				<ColumnHead label="Last used" width={COL.lastUsed} />
				<ColumnHead label="Expires" width={COL.expires} />
				<span className={COL.menu} />
			</DataTable.Head>
			{rows.map((row) => {
				if (row.source === "ingest") {
					return (
						<IngestRow
							key={row.id}
							row={row}
							formatDate={formatDate}
							onRoll={viewer.isAdmin ? () => onIngestRoll(row.type) : undefined}
						/>
					)
				}
				const can = apiKeyRowPermissions(row.key, viewer)
				return (
					<ApiRow
						key={row.id}
						row={row}
						now={now}
						formatDate={formatDate}
						onRoll={can.canRoll ? () => onRoll(row.key) : undefined}
						onRevoke={can.canRevoke ? () => onRevoke(row.key) : undefined}
					/>
				)
			})}
		</DataTable.Root>
	)
}

const ROW_CLASS =
	"flex items-center gap-4 border-b border-border/40 px-4 py-3 transition-colors last:border-0"

function TypeBadge({ type }: { type: KeyType }) {
	return (
		<Badge variant={TYPE_BADGE[type]} size="sm" mono>
			{KEY_TYPE_LABELS[type]}
		</Badge>
	)
}

function IngestRow({
	row,
	formatDate,
	onRoll,
}: {
	row: IngestKeyRow
	formatDate: (timestamp: string) => string
	onRoll?: () => void
}) {
	return (
		<div className={cn(ROW_CLASS, "hover:bg-muted/20")}>
			<div className={cn(COL.name, "flex flex-col gap-1")}>
				<div className="flex min-w-0 items-center gap-2">
					<TruncatedText text={row.name} className="text-foreground text-sm font-medium" />
					<TypeBadge type={row.type} />
				</div>
				<TruncatedText text={row.purpose} className="text-muted-foreground text-2xs" />
				<IngestKeyValue label={row.name} value={row.value} />
				<span className="text-muted-foreground truncate text-2xs">
					Rotated {formatDate(row.rotatedAt)}
				</span>
			</div>
			<TruncatedText
				text={keyAccessSummary(row)}
				className={cn(COL.access, "text-foreground/80 text-2xs")}
			/>
			<span className={cn(COL.createdBy, "text-muted-foreground text-2xs")}>Organization</span>
			<span className={cn(COL.lastUsed, "text-muted-foreground text-2xs")}>n/a</span>
			<span className={cn(COL.expires, "text-muted-foreground text-2xs")}>Never</span>
			<div className={cn(COL.menu, "flex items-center justify-end")}>
				{onRoll && (
					<RowActionsMenu label={`Actions for ${row.name.toLowerCase()}`}>
						<DropdownMenuItem onClick={onRoll}>
							<ArrowPathIcon />
							Roll key
						</DropdownMenuItem>
					</RowActionsMenu>
				)}
			</div>
		</div>
	)
}

/** "In 3 days" / "Today": the urgency. The date sits under it. */
function expiresInLabel(expiresAt: number, now: number): string {
	const days = Math.floor((expiresAt - now) / 86_400_000)
	if (days < 1) return "Today"
	return days === 1 ? "In 1 day" : `In ${days} days`
}

function ApiRow({
	row,
	now,
	formatDate,
	onRoll,
	onRevoke,
}: {
	row: ApiKeyRow
	/** The clock the status was derived from, so the badge cannot disagree with the bucket. */
	now: number
	formatDate: (timestamp: string) => string
	onRoll?: () => void
	onRevoke?: () => void
}) {
	const { key, status } = row
	const dead = status === "revoked" || status === "expired"
	const expiresAt = key.expires_at === null ? null : Date.parse(key.expires_at)
	const access = keyAccessSummary(row)
	return (
		<div className={cn(ROW_CLASS, dead ? "opacity-60" : "hover:bg-muted/20")}>
			<div className={cn(COL.name, "flex flex-col gap-1")}>
				<div className="flex min-w-0 items-center gap-2">
					<TruncatedText text={key.name} className="text-foreground text-sm font-medium" />
					<span className="text-muted-foreground shrink-0 font-mono text-2xs">
						{key.key_prefix}
					</span>
					<TypeBadge type={row.type} />
				</div>
				{key.description ? (
					<TruncatedText text={key.description} className="text-muted-foreground text-2xs" />
				) : null}
			</div>
			<TruncatedText text={access} className={cn(COL.access, "text-foreground/80 text-2xs")} />
			{/* Display lives on the lane wrapper so `hidden` is never merged away by an inner `flex`. */}
			<div className={COL.createdBy}>
				<div className="flex min-w-0 flex-col gap-0.5 text-2xs">
					<TruncatedText
						text={key.created_by_email ?? EMPTY_VALUE}
						className="text-foreground/80"
					/>
					<span className="text-muted-foreground truncate">{formatDate(key.created_at)}</span>
				</div>
			</div>
			<span className={cn(COL.lastUsed, "text-muted-foreground truncate text-2xs")}>
				{key.last_used_at ? <RelativeTime value={key.last_used_at} tooltip="title" /> : EMPTY_VALUE}
			</span>
			<div className={cn(COL.expires, "flex flex-col items-start gap-0.5 text-2xs")}>
				{status === "revoked" ? (
					<Badge variant="crit" size="sm">
						Revoked
					</Badge>
				) : status === "expired" ? (
					<Badge variant="outline" size="sm">
						Expired
					</Badge>
				) : status === "expiring" && expiresAt !== null ? (
					<Badge variant="warn" size="sm">
						{expiresInLabel(expiresAt, now)}
					</Badge>
				) : null}
				<span className={status === "expiring" ? "text-severity-warn" : "text-muted-foreground"}>
					{key.expires_at ? formatDate(key.expires_at) : "Never"}
				</span>
			</div>
			<div className={cn(COL.menu, "flex items-center justify-end")}>
				{(onRoll || onRevoke) && (
					<RowActionsMenu label={`Actions for ${key.name}`}>
						{onRoll && (
							<DropdownMenuItem onClick={onRoll}>
								<ArrowPathIcon />
								Roll key
							</DropdownMenuItem>
						)}
						{onRevoke && (
							<DropdownMenuItem variant="destructive" onClick={onRevoke}>
								<TrashIcon />
								Revoke key
							</DropdownMenuItem>
						)}
					</RowActionsMenu>
				)}
			</div>
		</div>
	)
}

function OAuthPointer() {
	return (
		<p className="text-muted-foreground w-full rounded-md border border-dashed px-4 py-3 text-sm">
			Clients signed in with OAuth don't use keys. See and revoke them in{" "}
			<Link
				to="/settings"
				search={{ tab: "mcp" }}
				className="text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline"
			>
				MCP
				<ArrowRightIcon size={12} />
				Connected clients
			</Link>
		</p>
	)
}
