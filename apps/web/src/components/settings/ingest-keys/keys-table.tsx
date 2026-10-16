import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import type { V2CustomIngestKey } from "@maple/domain/http/v2"
import { useState } from "react"

import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Input } from "@maple/ui/components/ui/input"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { ChevronRightIcon, KeyIcon, PlusIcon } from "@/components/icons"
import { ErrorState } from "@/components/common/error-state"
import { customIngestKeysListAtom } from "@/lib/services/atoms/ingestion-atoms"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { KeyStatusMark } from "./key-status"
import { useIngestionNavigation } from "./navigation"
import {
	ACTIVITY_LABELS,
	attributeCountLabel,
	keyActivity,
	pausedLabel,
	rateLimitLabel,
	signalsSummary,
	toPublicKeyId,
} from "./shared"

const MAX_KEYS = 50

const keySubtitle = (key: V2CustomIngestKey, now: number) => {
	const activity = keyActivity(key, now)
	if (activity === "paused") return pausedLabel(key)
	if (activity === "expired" || key.expires_at === null) return ACTIVITY_LABELS[activity]
	return `${ACTIVITY_LABELS[activity]} · expires ${formatRelativeTime(key.expires_at, now)}`
}

function DefaultKeyRow({
	label,
	value,
	audience,
	onOpen,
}: {
	label: string
	value: string | null
	audience: string
	onOpen: () => void
}) {
	return (
		<TableRow className="cursor-pointer" onClick={onOpen}>
			<TableCell>
				<div className="flex min-w-0 items-center gap-3">
					<StatusDot tone="ok" size="lg" />
					<div className="flex min-w-0 flex-col gap-0.5">
						<span className="text-sm font-medium">{label}</span>
						<span className="text-muted-foreground truncate font-mono text-2xs">
							{value === null ? "…" : `${value.slice(0, 14)}…`} · Default, {audience}
						</span>
					</div>
				</div>
			</TableCell>
			<TableCell className="whitespace-normal">All signals</TableCell>
			<TableCell className="text-muted-foreground">No limit</TableCell>
			<TableCell className="text-muted-foreground">None</TableCell>
			<TableCell className="text-muted-foreground text-right">-</TableCell>
			<TableCell>
				<ChevronRightIcon size={14} className="text-muted-foreground" />
			</TableCell>
		</TableRow>
	)
}

export function IngestKeysTable() {
	const nav = useIngestionNavigation()
	const [filter, setFilter] = useState("")
	const listResult = useAtomValue(customIngestKeysListAtom)
	const refreshKeys = useAtomRefresh(customIngestKeysListAtom)
	const defaultsResult = useAtomValue(retainedQueryV2("ingestKeys", "retrieve", {}))
	const defaults = Result.builder(defaultsResult)
		.onSuccess((keys) => ({ privateKey: keys.private_key, publicKey: keys.public_key }))
		.orElse(() => ({ privateKey: null, publicKey: null }))

	const now = Date.now()
	const keys = Result.builder(listResult)
		.onSuccess((response) => [...response.data])
		.orElse((): ReadonlyArray<V2CustomIngestKey> => [])
	const needle = filter.trim().toLowerCase()
	const visible = needle
		? keys.filter(
				(key) =>
					key.name.toLowerCase().includes(needle) ||
					key.key_prefix.toLowerCase().includes(needle) ||
					(key.description ?? "").toLowerCase().includes(needle),
			)
		: keys
	const atCap = keys.length >= MAX_KEYS

	return (
		<div className="flex w-full max-w-4xl flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<Input
					aria-label="Filter keys"
					placeholder="Filter keys"
					className="max-w-xs"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
				/>
				<div className="flex min-w-0 items-center gap-3">
					{Result.isSuccess(listResult) && (
						<span className="text-muted-foreground font-mono text-2xs">
							{keys.length} of {MAX_KEYS} custom keys
						</span>
					)}
					<Button size="sm" onClick={nav.openNewKey} disabled={atCap}>
						<PlusIcon data-icon="inline-start" />
						New key
					</Button>
				</div>
			</div>

			<Table variant="card" className="table-fixed">
				<TableHeader>
					<TableRow>
						<TableHead>Key</TableHead>
						<TableHead className="w-40">Signals</TableHead>
						<TableHead className="w-24">Rate limit</TableHead>
						<TableHead className="w-28">Overrides</TableHead>
						<TableHead className="w-24 text-right">Last data</TableHead>
						<TableHead className="w-10" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{needle.length === 0 && (
						<>
							<DefaultKeyRow
								label="Private key"
								value={defaults.privateKey}
								audience="servers"
								onOpen={() => nav.openView("setup")}
							/>
							<DefaultKeyRow
								label="Public key"
								value={defaults.publicKey}
								audience="browsers"
								onOpen={() => nav.openView("setup")}
							/>
						</>
					)}
					{Result.isInitial(listResult) ? (
						<TableRow>
							<TableCell colSpan={6}>
								<Skeleton className="h-9 w-full" />
							</TableCell>
						</TableRow>
					) : !Result.isSuccess(listResult) ? (
						<TableRow>
							<TableCell colSpan={6} className="p-0">
								<ErrorState
									error={listResult.cause}
									title="Couldn't load custom keys"
									onRetry={() => refreshKeys()}
									className="border-0"
								/>
							</TableCell>
						</TableRow>
					) : (
						visible.map((key) => {
							const activity = keyActivity(key, now)
							const muted = activity === "paused" || activity === "expired"
							return (
								<TableRow
									key={key.id}
									className="cursor-pointer"
									onClick={() => nav.openKey(toPublicKeyId(key.id))}
								>
									<TableCell>
										<div className="flex min-w-0 items-center gap-3">
											<span className="flex w-2 justify-center">
												<KeyStatusMark activity={activity} />
											</span>
											<div className="flex min-w-0 flex-col gap-0.5">
												<span className="truncate text-sm font-medium">
													{key.name}
												</span>
												<span className="text-muted-foreground truncate font-mono text-2xs">
													{key.key_prefix}… · {keySubtitle(key, now)}
												</span>
											</div>
										</div>
									</TableCell>
									<TableCell
										className={cn("whitespace-normal", muted && "text-muted-foreground")}
									>
										{signalsSummary(key.allowed_signals)}
									</TableCell>
									<TableCell className={cn(muted && "text-muted-foreground")}>
										{rateLimitLabel(key.rate_limit_rps)}
									</TableCell>
									<TableCell className={cn(muted && "text-muted-foreground")}>
										{attributeCountLabel(key.resource_attributes.length)}
									</TableCell>
									<TableCell
										className={cn(
											"text-right",
											activity === "paused" || activity === "waiting"
												? "text-severity-warn"
												: muted && "text-muted-foreground",
										)}
									>
										{activity === "paused"
											? "Paused"
											: key.last_used_at === null
												? "Never"
												: formatRelativeTime(key.last_used_at, now)}
									</TableCell>
									<TableCell>
										<ChevronRightIcon size={14} className="text-muted-foreground" />
									</TableCell>
								</TableRow>
							)
						})
					)}
				</TableBody>
			</Table>

			{Result.isSuccess(listResult) && keys.length === 0 && (
				<Empty className="py-8">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<KeyIcon size={16} />
						</EmptyMedia>
						<EmptyTitle>No custom keys yet</EmptyTitle>
						<EmptyDescription>
							Give a team or environment its own key to cap its request rate, stamp a{" "}
							<InlineCode variant="plain">service.name</InlineCode> on everything it sends, or
							pause it without touching anyone else.
						</EmptyDescription>
					</EmptyHeader>
					<Button size="sm" onClick={nav.openNewKey}>
						<PlusIcon data-icon="inline-start" />
						New key
					</Button>
				</Empty>
			)}
		</div>
	)
}
