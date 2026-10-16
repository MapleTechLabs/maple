import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type { V2CustomIngestKey, V2CustomIngestKeyUsage } from "@maple/domain/http/v2"
import { Link } from "@tanstack/react-router"
import type * as React from "react"
import { useState } from "react"

import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Panel } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { formatNumber } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { ArrowPathIcon, MediaPauseIcon, MediaPlayIcon, SlidersIcon, TrashIcon } from "@/components/icons"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { toastExit } from "@/lib/error-toast"
import { customIngestKeysListAtom } from "@/lib/services/atoms/ingestion-atoms"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { KeyStatusMark } from "./key-status"
import {
	ACTIVITY_LABELS,
	keyActivity,
	MODE_LABELS,
	pausedLabel,
	rateLimitLabel,
	type RevealedSecret,
	signalsSummary,
	toPublicKeyId,
} from "./shared"

const HOUR_MS = 3_600_000

const PAUSE_CHOICES = [
	{ label: "For 1 hour", hours: 1 },
	{ label: "For 24 hours", hours: 24 },
	{ label: "Until I resume", hours: null },
] as const

const SNIPPETS = {
	env: {
		label: "Environment",
		render: (secret: string) =>
			`OTEL_EXPORTER_OTLP_ENDPOINT=${ingestUrl}\nOTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${secret}"`,
	},
	collector: {
		label: "OTel Collector",
		render: (secret: string) =>
			`exporters:\n  otlphttp/maple:\n    endpoint: ${ingestUrl}\n    headers:\n      Authorization: "Bearer ${secret}"`,
	},
	browser: {
		label: "Browser SDK",
		render: (secret: string) =>
			`import { MapleBrowser } from "@maple-dev/browser"\n\nMapleBrowser.init({\n  ingestKey: "${secret}",\n  endpoint: "${ingestUrl}",\n})`,
	},
} as const
type SnippetId = keyof typeof SNIPPETS
const isSnippetId = (value: unknown): value is SnippetId =>
	typeof value === "string" && Object.hasOwn(SNIPPETS, value)

function SecretCard({ revealed }: { revealed: RevealedSecret }) {
	const [snippet, setSnippet] = useState<SnippetId>("env")
	const code = SNIPPETS[snippet].render(revealed.secret)
	return (
		<Panel padded className="gap-3">
			<div className="flex items-center justify-between">
				<span className="text-sm font-medium">Secret</span>
				<span className="text-muted-foreground font-mono text-2xs">Shown once</span>
			</div>
			<CopyableField value={revealed.secret} copyLabel="Ingest key" />
			<Panel tone="background">
				<Tabs value={snippet} onValueChange={(value) => isSnippetId(value) && setSnippet(value)}>
					<div className="flex items-center justify-between border-b pr-1 pl-3">
						<TabsList variant="underline">
							{Object.entries(SNIPPETS).map(([id, entry]) => (
								<TabsTrigger key={id} value={id}>
									{entry.label}
								</TabsTrigger>
							))}
						</TabsList>
						<CopyButton value={code} label={`${SNIPPETS[snippet].label} snippet`} />
					</div>
				</Tabs>
				<pre className="overflow-x-auto p-3 font-mono text-xs leading-5">{code}</pre>
			</Panel>
		</Panel>
	)
}

function Banner({
	tone,
	title,
	description,
	action,
}: {
	tone: "ok" | "warn" | "muted"
	title: string
	description?: string
	action?: React.ReactNode
}) {
	return (
		<div
			role="status"
			className={cn(
				"flex items-center gap-3 rounded-md border px-4 py-3",
				tone === "ok" && "border-severity-info/35 bg-severity-info/10",
				tone === "warn" && "border-severity-warn/35 bg-severity-warn/10",
				tone === "muted" && "bg-muted/40",
			)}
		>
			<div className="min-w-0 flex-1 space-y-0.5">
				<p className="text-sm">{title}</p>
				{description && <p className="text-muted-foreground text-xs">{description}</p>}
			</div>
			{action}
		</div>
	)
}

function StatCard({
	label,
	value,
	hint,
	valueClassName,
}: {
	label: string
	value: React.ReactNode
	hint: string
	valueClassName?: string
}) {
	return (
		<Panel padded className="gap-1.5">
			<span className="text-muted-foreground text-2xs">{label}</span>
			<span className={cn("font-display truncate text-xl font-medium", valueClassName)}>{value}</span>
			<span className="text-muted-foreground text-2xs">{hint}</span>
		</Panel>
	)
}

/** 24 hourly stacked bars, spans over logs; hours without data stay empty. */
function UsageChart({ usage }: { usage: V2CustomIngestKeyUsage }) {
	const end = Math.floor(new Date(usage.window_end).getTime() / HOUR_MS) * HOUR_MS
	const byHour = new Map(usage.buckets.map((bucket) => [new Date(bucket.hour).getTime(), bucket]))
	const hours = Array.from({ length: 24 }, (_, index) => {
		const hour = end - (23 - index) * HOUR_MS
		const bucket = byHour.get(hour)
		return { hour, spans: bucket?.spans ?? 0, logs: bucket?.logs ?? 0 }
	})
	const peak = Math.max(1, ...hours.map((hour) => hour.spans + hour.logs))
	const width = 100 / hours.length
	return (
		<svg
			viewBox="0 0 100 40"
			preserveAspectRatio="none"
			className="h-24 w-full"
			role="img"
			aria-label="Spans and logs per hour over the last 24 hours"
		>
			{hours.map((hour, index) => {
				const logs = (hour.logs / peak) * 40
				const spans = (hour.spans / peak) * 40
				const x = index * width + width * 0.12
				const barWidth = width * 0.76
				return (
					<g key={hour.hour}>
						<title>
							{`${new Date(hour.hour).toLocaleTimeString(undefined, { hour: "numeric" })}: ${formatNumber(hour.spans)} spans, ${formatNumber(hour.logs)} logs`}
						</title>
						<rect
							x={x}
							y={40 - logs}
							width={barWidth}
							height={logs}
							className="fill-severity-debug"
						/>
						<rect
							x={x}
							y={40 - logs - spans}
							width={barWidth}
							height={spans}
							className="fill-primary"
						/>
					</g>
				)
			})}
		</svg>
	)
}

function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex gap-4 border-t px-4 py-3 text-sm">
			<span className="text-muted-foreground w-44 shrink-0">{label}</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	)
}

export function IngestKeyDetail({
	keyId,
	revealed,
	onRevealed,
	onConfigure,
	onDeleted,
}: {
	keyId: V2CustomIngestKey["id"]
	revealed: RevealedSecret | null
	onRevealed: (revealed: RevealedSecret) => void
	onConfigure: () => void
	onDeleted: () => void
}) {
	const listResult = useAtomValue(customIngestKeysListAtom)
	const refreshKeys = useAtomRefresh(customIngestKeysListAtom)
	const usageResult = useAtomValue(retainedQueryV2("ingestKeys", "usageCustom", { params: { id: keyId } }))

	const pauseMutation = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "pauseCustom"), {
		mode: "promiseExit",
	})
	const resumeMutation = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "resumeCustom"), {
		mode: "promiseExit",
	})
	const rollMutation = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "rollCustom"), {
		mode: "promiseExit",
	})
	const deleteMutation = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "deleteCustom"), {
		mode: "promiseExit",
	})
	const [rollOpen, setRollOpen] = useState(false)
	const [deleteOpen, setDeleteOpen] = useState(false)

	const [pause, pausing] = useAsyncAction(async (hours: number | null) => {
		const until = hours === null ? null : new Date(Date.now() + hours * HOUR_MS).toISOString()
		const result = await pauseMutation({ params: { id: keyId }, payload: { until } })
		if (
			toastExit(result, {
				success: "Ingestion paused. Takes effect within a minute.",
				error: "Failed to pause key",
			})
		)
			refreshKeys()
	})
	const [resume, resuming] = useAsyncAction(async () => {
		const result = await resumeMutation({ params: { id: keyId } })
		if (
			toastExit(result, {
				success: "Ingestion resumed. Takes effect within a minute.",
				error: "Failed to resume key",
			})
		)
			refreshKeys()
	})
	const [roll, rolling] = useAsyncAction(async () => {
		const result = await rollMutation({ params: { id: keyId } })
		setRollOpen(false)
		if (!toastExit(result, { error: "Failed to roll secret" })) return
		refreshKeys()
		if (result._tag === "Success") onRevealed({ keyId, secret: result.value.secret, rolled: true })
	})
	async function remove() {
		const ok = toastExit(await deleteMutation({ params: { id: keyId } }), {
			success: "Ingest key deleted",
			error: "Failed to delete ingest key",
		})
		if (ok) {
			refreshKeys()
			onDeleted()
		}
		return ok
	}

	if (Result.isInitial(listResult)) {
		return (
			<div className="flex w-full max-w-4xl flex-col gap-3">
				<Skeleton className="h-10 w-72" />
				<Skeleton className="h-28 w-full" />
				<Skeleton className="h-40 w-full" />
			</div>
		)
	}
	const key = Result.builder(listResult)
		.onSuccess((response) => response.data.find((candidate) => candidate.id === keyId) ?? null)
		.orElse(() => null)
	if (key === null) {
		return (
			<Banner
				tone="muted"
				title="This ingest key no longer exists."
				description="It may have been deleted by someone else."
			/>
		)
	}

	const now = Date.now()
	const activity = keyActivity(key, now)
	const publicId = toPublicKeyId(key.id)
	const showSecret = revealed !== null && revealed.keyId === key.id
	const usage = Result.builder(usageResult)
		.onSuccess((value): V2CustomIngestKeyUsage | null => value)
		.orElse(() => null)
	const totals = usage?.buckets.reduce(
		(sum, bucket) => ({ spans: sum.spans + bucket.spans, logs: sum.logs + bucket.logs }),
		{ spans: 0, logs: 0 },
	)

	return (
		<div className="flex w-full max-w-4xl flex-col gap-3">
			<header className="flex flex-col gap-3 pb-3">
				<div className="flex items-center gap-3.5">
					<KeyStatusMark activity={activity} large />
					<div className="min-w-0 space-y-1">
						<h1 className="font-display truncate text-2xl font-medium tracking-tight">
							{key.name}
						</h1>
						<p className="text-muted-foreground truncate font-mono text-xs">
							{activity === "paused" ? pausedLabel(key) : ACTIVITY_LABELS[activity]} ·{" "}
							{key.key_prefix}… · created {formatRelativeTime(key.created_at, now)}
						</p>
					</div>
				</div>
				{key.description !== null && (
					<p className="text-muted-foreground pl-6.5 text-sm">{key.description}</p>
				)}
				<div className="flex flex-wrap items-center gap-1 pl-5">
					<Button variant="ghost" size="sm" onClick={onConfigure}>
						<SlidersIcon data-icon="inline-start" />
						Configure
					</Button>
					<Button
						variant="ghost"
						size="sm"
						render={
							<Link
								to="/traces"
								search={{
									resourceAttributeFilters: [
										{ key: "maple_ingest_key_id", value: publicId },
									],
								}}
							/>
						}
					>
						View data
					</Button>
					{activity === "paused" ? (
						<Button
							variant="ghost"
							size="sm"
							className="text-primary"
							onClick={() => void resume()}
							loading={resuming}
						>
							<MediaPlayIcon data-icon="inline-start" />
							Resume
						</Button>
					) : (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="sm"
										loading={pausing}
										disabled={activity === "expired"}
									/>
								}
							>
								<MediaPauseIcon data-icon="inline-start" />
								Pause
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="w-72">
								<div className="space-y-1 px-2 pt-1.5 pb-2">
									<p className="text-xs font-medium">Pause ingestion</p>
									<p className="text-muted-foreground text-xs leading-relaxed">
										Senders keep getting 200 OK. Data is dropped, not stored or billed.
									</p>
								</div>
								<DropdownMenuSeparator />
								<DropdownMenuGroup>
									{PAUSE_CHOICES.map((choice) => (
										<DropdownMenuItem
											key={choice.label}
											onClick={() => void pause(choice.hours)}
										>
											{choice.label}
										</DropdownMenuItem>
									))}
								</DropdownMenuGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
					<Button variant="ghost" size="sm" onClick={() => setRollOpen(true)}>
						<ArrowPathIcon data-icon="inline-start" />
						Roll secret
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="text-destructive"
						onClick={() => setDeleteOpen(true)}
					>
						<TrashIcon data-icon="inline-start" />
						Delete
					</Button>
				</div>
			</header>

			{showSecret && (
				<Banner
					tone="ok"
					title={
						revealed.rolled
							? "Secret rolled. Copy the new one now: Maple stores only a hash, so it won't be shown again."
							: "Key created. Copy the secret now: Maple stores only a hash, so it won't be shown again."
					}
					description={
						revealed.rolled ? "The previous secret stops working within a minute." : undefined
					}
				/>
			)}
			{activity === "paused" && (
				<Banner
					tone="warn"
					title={
						key.paused_until === null
							? "Ingestion paused until you resume it."
							: `Ingestion paused, resumes automatically ${formatRelativeTime(key.paused_until, now)}.`
					}
					description="Senders still get 200 OK, so nothing retries or backs up. Data sent now is dropped and not billed."
					action={
						<Button size="sm" onClick={() => void resume()} loading={resuming}>
							Resume now
						</Button>
					}
				/>
			)}
			{activity === "expired" && key.expires_at !== null && (
				<Banner
					tone="muted"
					title={`Expired ${formatRelativeTime(key.expires_at, now)}. Senders are rejected with 401.`}
					description="Configure a new expiry to accept it again."
				/>
			)}
			{showSecret && <SecretCard revealed={revealed} />}

			<div className="grid gap-3 sm:grid-cols-3">
				<StatCard
					label="Receiving data"
					value={ACTIVITY_LABELS[activity]}
					valueClassName={cn(
						activity === "live" && "text-severity-info",
						(activity === "waiting" || activity === "paused") && "text-severity-warn",
						activity === "expired" && "text-muted-foreground",
					)}
					hint={
						key.last_used_at === null
							? "Updates once the first request lands"
							: `Last data ${formatRelativeTime(key.last_used_at, now)}`
					}
				/>
				<StatCard
					label="Last 24h"
					value={
						Result.isFailure(usageResult) ? (
							<span className="text-muted-foreground">Unavailable</span>
						) : totals === undefined ? (
							<Skeleton className="h-6 w-32" />
						) : (
							`${formatNumber(totals.spans)} spans · ${formatNumber(totals.logs)} logs`
						)
					}
					hint="Stored with this key"
				/>
				<StatCard
					label="Config changed"
					value={formatRelativeTime(key.updated_at, now)}
					hint="Edits reach every ingest server within a minute"
				/>
			</div>

			<Panel padded className="gap-3">
				<div className="flex items-center justify-between">
					<span className="text-sm font-medium">Volume · last 24h</span>
					<div className="text-muted-foreground flex items-center gap-3 text-2xs">
						<span className="flex items-center gap-1.5">
							<span className="bg-primary size-2 rounded-[2px]" />
							Spans
						</span>
						<span className="flex items-center gap-1.5">
							<span className="bg-severity-debug size-2 rounded-[2px]" />
							Logs
						</span>
					</div>
				</div>
				{usage === null ? (
					Result.isFailure(usageResult) ? (
						<p className="text-muted-foreground py-6 text-center text-xs">
							Volume is unavailable right now.
						</p>
					) : (
						<Skeleton className="h-24 w-full" />
					)
				) : usage.buckets.length === 0 ? (
					<p className="text-muted-foreground py-8 text-center text-xs">
						No spans or logs stored with this key in the last 24 hours.
					</p>
				) : (
					<UsageChart usage={usage} />
				)}
			</Panel>

			<Panel>
				<div className="flex items-center justify-between px-4 py-3">
					<span className="text-sm font-medium">Configuration</span>
					<Button
						variant="link"
						size="sm"
						className="text-primary h-auto p-0"
						onClick={onConfigure}
					>
						Configure
					</Button>
				</div>
				<ConfigRow label="Signals">{signalsSummary(key.allowed_signals)}</ConfigRow>
				<ConfigRow label="Rate limit">{rateLimitLabel(key.rate_limit_rps)}</ConfigRow>
				<ConfigRow label="Expires">
					{key.expires_at === null ? "Never" : formatRelativeTime(key.expires_at, now)}
				</ConfigRow>
				<ConfigRow label="Resource attributes">
					{key.resource_attributes.length === 0 ? (
						<span className="text-muted-foreground">None</span>
					) : (
						<div className="space-y-1 font-mono text-xs">
							{key.resource_attributes.map((attribute) => (
								<div key={attribute.key} className="flex flex-wrap gap-x-3">
									<span className="break-all">
										{attribute.key} = {attribute.value}
									</span>
									<span className="text-muted-foreground">
										{MODE_LABELS[attribute.mode].toLowerCase()}
									</span>
								</div>
							))}
						</div>
					)}
				</ConfigRow>
				<ConfigRow label="Secret">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<span className="font-mono text-xs">{key.key_prefix}••••••••••••••••</span>
						<span className="text-muted-foreground text-2xs">
							Hidden after creation. Roll to get a new one.
						</span>
					</div>
				</ConfigRow>
			</Panel>

			<ConfirmDialog
				open={rollOpen}
				onOpenChange={setRollOpen}
				title="Roll this key's secret?"
				description={
					<>
						<span className="text-foreground font-medium">{key.name}</span> gets a new secret and
						keeps its settings. Senders using the old secret are rejected within a minute.
					</>
				}
				confirmLabel="Roll secret"
				onConfirm={() => void roll()}
				pending={rolling}
			/>
			<ConfirmDialog
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				title="Delete ingest key?"
				description={
					<>
						Senders using <span className="text-foreground font-medium">{key.name}</span> are
						rejected within a minute. This cannot be undone.
					</>
				}
				confirmLabel="Delete"
				onConfirm={remove}
			/>
		</div>
	)
}
