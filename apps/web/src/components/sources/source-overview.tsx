import type { V2Source, V2SourceUsage } from "@maple/domain/http/v2"
import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Panel } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatNumber } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import type * as React from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { hasToken, MODE_LABELS, pausedLabel, rateLimitLabel, signalsSummary } from "./shared"
import { SourceStatusBadge, sourceStatus, sourceStatusLabel } from "./source-status"
import { UsageChart } from "./usage-chart"

function StatCard({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) {
	return (
		<Panel padded className="gap-1.5">
			<span className="text-muted-foreground text-xs">{label}</span>
			<span className="truncate text-base font-medium">{value}</span>
			<span className="text-muted-foreground text-xs">{hint}</span>
		</Panel>
	)
}

function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex gap-4 border-t px-4 py-3 text-sm first:border-t-0">
			<span className="text-muted-foreground w-44 shrink-0">{label}</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	)
}

/** Integrations that only send metrics, which the usage counts do not cover yet. */
const METRICS_ONLY = new Set<V2Source["platform"]>(["prometheus", "cloudflare", "railway", "planetscale"])

export function SourceOverview({ source }: { source: V2Source }) {
	const usageResult = useAtomValue(retainedQueryV2("sources", "usage", { params: { id: source.id } }))
	const now = Date.now()
	const usage = Result.builder(usageResult)
		.onSuccess((value): V2SourceUsage | null => value)
		.orElse(() => null)
	const totals = usage?.buckets.reduce(
		(sum, bucket) => ({ spans: sum.spans + bucket.spans, logs: sum.logs + bucket.logs }),
		{ spans: 0, logs: 0 },
	)

	return (
		<div className="flex flex-col gap-4">
			{source.status === "paused" && (
				<Alert variant="warn">
					<AlertTitle>{pausedLabel(source)}</AlertTitle>
					<AlertDescription className="text-xs">
						Senders still get 200 OK, so nothing retries. Data sent now is dropped and not billed.
					</AlertDescription>
				</Alert>
			)}
			{source.status === "expired" && source.expires_at !== null && (
				<Alert>
					<AlertTitle>Expired {formatRelativeTime(source.expires_at, now)}</AlertTitle>
					<AlertDescription className="text-xs">
						Senders are rejected with 401. Set a new expiry in Settings to accept it again.
					</AlertDescription>
				</Alert>
			)}
			{source.health.problem !== null && source.status !== "paused" && source.status !== "expired" && (
				<Alert variant={source.health.status === "stale" ? "warn" : "crit"}>
					<AlertTitle>{sourceStatusLabel(source.health.status)}</AlertTitle>
					<AlertDescription className="text-xs">{source.health.problem}</AlertDescription>
				</Alert>
			)}
			<div className="grid gap-3 sm:grid-cols-3">
				<StatCard
					label="Status"
					value={<SourceStatusBadge value={sourceStatus(source)} now={now} showTime={false} />}
					hint={
						source.health.last_data_at === null
							? "Updates once the first data lands"
							: "Updated at most once a minute"
					}
				/>
				<StatCard
					label="Last data"
					value={
						source.health.last_data_at === null
							? "Never"
							: formatRelativeTime(source.health.last_data_at, now)
					}
					hint={
						hasToken(source) || source.is_default
							? "Last request the gateway accepted"
							: "Last successful collection"
					}
				/>
				{!METRICS_ONLY.has(source.platform) && (
					<StatCard
						label="Last 24h"
						value={
							Result.isFailure(usageResult) ? (
								<span className="text-muted-foreground">Unavailable</span>
							) : totals === undefined ? (
								<Skeleton className="h-5 w-32" />
							) : (
								`${formatNumber(totals.spans)} spans · ${formatNumber(totals.logs)} logs`
							)
						}
						hint="Stored from this source"
					/>
				)}
			</div>
			{METRICS_ONLY.has(source.platform) ? (
				<p className="text-muted-foreground text-xs">
					This source sends metrics. Per-source metric volume is not counted yet.
				</p>
			) : (
				<Panel padded className="gap-3">
					<span className="text-sm font-medium">Volume, last 24 hours</span>
					{usage === null ? (
						Result.isFailure(usageResult) ? (
							<p className="text-muted-foreground py-6 text-center text-xs">
								Volume is unavailable right now.
							</p>
						) : (
							<Skeleton className="h-48 w-full" />
						)
					) : usage.buckets.length === 0 ? (
						<p className="text-muted-foreground py-8 text-center text-xs">
							No spans or logs from this source in the last 24 hours.
						</p>
					) : (
						<UsageChart usage={usage} />
					)}
				</Panel>
			)}
			{hasToken(source) && <RulesSummary source={source} now={now} />}
		</div>
	)
}

function RulesSummary({ source, now }: { source: V2Source; now: number }) {
	return (
		<Panel>
			<ConfigRow label="Signals">{signalsSummary(source.allowed_signals)}</ConfigRow>
			<ConfigRow label="Rate limit">{rateLimitLabel(source.rate_limit_rps)}</ConfigRow>
			<ConfigRow label="Expires">
				{source.expires_at === null ? "Never" : formatRelativeTime(source.expires_at, now)}
			</ConfigRow>
			<ConfigRow label="Resource attributes">
				{source.resource_attributes.length === 0 ? (
					<span className="text-muted-foreground">None</span>
				) : (
					<div className="space-y-1 font-mono text-xs">
						{source.resource_attributes.map((attribute) => (
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
		</Panel>
	)
}
