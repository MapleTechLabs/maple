// The Worker detail page's parts. Presentational: the route fetches, the lab feeds fixtures.

import { useMemo } from "react"
import { Link } from "@tanstack/react-router"

import { DetailRail } from "@maple/ui/components/detail-rail"
import { Panel, PanelHeader } from "@maple/ui/components/ui/panel"
import { SegmentedBar } from "@maple/ui/components/ui/meter"
import { cn } from "@maple/ui/lib/utils"
import {
	EMPTY_VALUE,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { CodeIcon, PulseIcon, ServerIcon, StopwatchIcon, UserIcon } from "@maple/ui/components/icons"

import type { CloudflareWorkerDetail } from "@/api/warehouse/cloudflare-infra"
import { HeroChip, PageHero } from "@/components/common/page-hero"
import { CorrelationStrips, type StripSeries } from "../service-lens/correlation-strips"
import type { ChartEventMarker } from "../primitives/chart-event-markers"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimeInTimezone } from "@/lib/timezone-format"
import { workerHealth, type WorkerHealth, type WorkerListRow } from "./list-model"
import {
	DURABLE_OBJECT_COLORS,
	FAILURE_COLORS,
	durableObjectRows,
	failureRows,
	invocationRows,
	outcomeLabel,
	percentileRows,
	workerOutcomeTotals,
	type WorkerOutcomeTotals,
} from "./worker-signals"

const HEALTH_DOT = {
	erroring: "bg-severity-error",
	slow: "bg-severity-warn",
	ok: "bg-severity-info",
} satisfies Record<WorkerHealth, string>

export function CloudflareWorkerHeader({
	scriptName,
	row,
	accountName,
	tracedService,
	currentVersion,
}: {
	scriptName: string
	row: WorkerListRow | null
	accountName: string | null
	/** The trace-emitting service this Worker matched, if any. */
	tracedService: string | null
	currentVersion: string | null
}) {
	return (
		<PageHero
			title={
				<span className="flex items-center gap-3">
					{row === null ? null : (
						<span
							aria-hidden
							className={cn("size-2 shrink-0 rounded-full", HEALTH_DOT[workerHealth(row)])}
						/>
					)}
					{scriptName}
				</span>
			}
			meta={
				<>
					<HeroChip>worker</HeroChip>
					{accountName === null ? null : <HeroChip>account {accountName}</HeroChip>}
					{tracedService === null ? (
						<HeroChip>no traces matched</HeroChip>
					) : (
						<Link to="/services/$serviceName" params={{ serviceName: tracedService }}>
							<HeroChip>traced as {tracedService}</HeroChip>
						</Link>
					)}
					{currentVersion === null ? null : (
						<HeroChip>version {currentVersion.slice(0, 7)}</HeroChip>
					)}
				</>
			}
		/>
	)
}

/** Only rendered when Cloudflare saw failures the Worker's own spans never recorded. */
export function CloudflareTraceGapCallout({
	exceptions,
	tracedErrors,
	tracedService,
}: {
	exceptions: number
	tracedErrors: number
	tracedService: string
}) {
	return (
		<div className="@container rounded-lg border border-severity-error/40">
			<div className="flex flex-col @2xl:flex-row @2xl:items-center">
				<div className="flex-1 space-y-1 px-4 py-3">
					<p className="text-sm font-medium text-foreground">
						{formatNumber(exceptions)} exceptions in Cloudflare,{" "}
						{tracedErrors === 0 ? "none" : formatNumber(tracedErrors)} in traces
					</p>
					<p className="max-w-prose text-xs text-muted-foreground">
						These invocations most likely threw before {tracedService} exported a span, so tracing
						never saw them.
					</p>
				</div>
				<div className="flex items-center gap-6 border-t px-4 py-3 @2xl:self-stretch @2xl:border-t-0 @2xl:border-l @2xl:px-5">
					<Figure
						value={formatNumber(exceptions)}
						caption="Cloudflare"
						className="text-severity-error"
					/>
					<Figure value={formatNumber(tracedErrors)} caption="traces" />
					<Link
						to="/logs"
						search={{ services: [tracedService] }}
						className="ml-auto font-mono text-xs text-primary hover:text-primary/80 @2xl:ml-0"
					>
						Logs in this window
					</Link>
				</div>
			</div>
		</div>
	)
}

function Figure({ value, caption, className }: { value: string; caption: string; className?: string }) {
	return (
		<div className="flex flex-col items-start @2xl:items-end">
			<span className={cn("font-mono text-sm font-semibold tabular-nums text-foreground", className)}>
				{value}
			</span>
			<span className="font-mono text-3xs text-muted-foreground">{caption}</span>
		</div>
	)
}

export function CloudflareWorkerSignals({
	detail,
	row,
	markers,
	waiting,
}: {
	detail: CloudflareWorkerDetail
	row: WorkerListRow | null
	markers?: ReadonlyArray<ChartEventMarker>
	waiting?: boolean
}) {
	const totals = useMemo(() => workerOutcomeTotals(detail.outcomeBuckets), [detail.outcomeBuckets])
	const xDomain = useMemo(
		() =>
			[
				...new Set(
					[...detail.outcomeBuckets, ...detail.latencyBuckets, ...detail.durableObjectBuckets].map(
						(b) => b.bucket,
					),
				),
			].toSorted(),
		[detail.outcomeBuckets, detail.latencyBuckets, detail.durableObjectBuckets],
	)
	const series = useMemo(() => buildStrips(detail, row, totals), [detail, row, totals])
	return <CorrelationStrips series={series} xDomain={xDomain} markers={markers} waiting={waiting} />
}

function buildStrips(
	detail: CloudflareWorkerDetail,
	row: WorkerListRow | null,
	totals: WorkerOutcomeTotals,
): StripSeries[] {
	const failureRate = totals.invocations > 0 ? totals.failures / totals.invocations : 0
	const strips: StripSeries[] = [
		{
			id: "cf-invocations",
			label: "Invocations",
			source: "all outcomes",
			rows: invocationRows(detail.outcomeBuckets),
			unit: "count",
			summary: (
				<Summary
					value={formatNumber(totals.invocations)}
					caption={`${formatPercent(totals.invocations > 0 ? 1 - failureRate : 0)} success`}
				/>
			),
		},
		{
			id: "cf-failures",
			label: "Failures",
			source: "by how they ended",
			rows: failureRows(detail.outcomeBuckets),
			unit: "count",
			colors: FAILURE_COLORS,
			summary: (
				<Summary
					value={formatNumber(totals.failures)}
					valueClassName={totals.failures > 0 ? "text-severity-error" : undefined}
					caption={formatErrorRate(failureRate)}
				/>
			),
		},
		{
			id: "cf-cpu",
			label: "CPU time",
			source: "p99 and p50",
			rows: percentileRows(detail.latencyBuckets, (b) => [b.cpuP50Ms, b.cpuP99Ms]),
			unit: "milliseconds",
			summary: (
				<Summary
					value={row && row.cpuP99Ms > 0 ? formatLatency(row.cpuP99Ms) : EMPTY_VALUE}
					caption="p99"
				/>
			),
		},
		{
			id: "cf-duration",
			label: "Duration",
			source: "wall time, p99 and p50",
			rows: percentileRows(detail.latencyBuckets, (b) => [b.durationP50Ms, b.durationP99Ms]),
			unit: "milliseconds",
			summary: (
				<Summary
					value={row && row.durationP99Ms > 0 ? formatLatency(row.durationP99Ms) : EMPTY_VALUE}
					caption="p99"
				/>
			),
		},
	]
	if (detail.durableObjectBuckets.some((b) => b.requests > 0)) {
		const calls = detail.durableObjectBuckets.reduce((acc, b) => acc + b.requests, 0)
		const errors = detail.durableObjectBuckets.reduce((acc, b) => acc + b.errors, 0)
		strips.push(
			{
				id: "cf-do-calls",
				label: "Durable Objects",
				source: "calls and errors",
				rows: durableObjectRows(detail.durableObjectBuckets),
				unit: "count",
				colors: DURABLE_OBJECT_COLORS,
				summary: (
					<Summary
						value={formatNumber(calls)}
						caption={`${formatErrorRate(calls > 0 ? errors / calls : 0)} failed`}
						captionClassName={
							errors / Math.max(calls, 1) >= 0.01 ? "text-severity-error" : undefined
						}
					/>
				),
			},
			{
				id: "cf-do-wall",
				label: "DO wall time",
				source: "p99 and p50",
				rows: percentileRows(detail.latencyBuckets, (b) => [b.doWallP50Ms, b.doWallP99Ms]),
				unit: "milliseconds",
			},
		)
	}
	return strips
}

function Summary({
	value,
	caption,
	valueClassName,
	captionClassName,
}: {
	value: string
	caption?: string
	valueClassName?: string
	captionClassName?: string
}) {
	return (
		<>
			<span
				className={cn("font-mono text-sm font-semibold tabular-nums text-foreground", valueClassName)}
			>
				{value}
			</span>
			{caption === undefined ? null : (
				<span className={cn("font-mono text-3xs text-muted-foreground", captionClassName)}>
					{caption}
				</span>
			)}
		</>
	)
}

/** How each invocation ended, per Cloudflare. */
export function CloudflareWorkerOutcomes({ detail }: { detail: CloudflareWorkerDetail }) {
	const totals = useMemo(() => workerOutcomeTotals(detail.outcomeBuckets), [detail.outcomeBuckets])
	return (
		<Panel>
			<PanelHeader title="Outcomes" />
			<div className="divide-y divide-border/40">
				{totals.byStatus.map(({ status, count }) => {
					const success = status === "success"
					const share = totals.invocations > 0 ? count / totals.invocations : 0
					return (
						<div key={status} className="flex items-center gap-4 px-4 py-2.5">
							<span
								aria-hidden
								className={cn(
									"size-2 shrink-0 rounded-sm",
									success ? "bg-severity-info" : "bg-severity-error",
								)}
							/>
							<div className="flex min-w-0 flex-1 items-baseline gap-2">
								<span className="truncate text-xs text-foreground">
									{outcomeLabel(status)}
								</span>
								{outcomeLabel(status).toLowerCase() === status.toLowerCase() ? null : (
									<span className="truncate font-mono text-3xs text-muted-foreground">
										{status}
									</span>
								)}
							</div>
							<SegmentedBar
								className="w-48 shrink-0"
								minVisible={1}
								total={totals.invocations}
								segments={[
									{
										key: status,
										value: count,
										className: success ? "bg-muted-foreground/60" : "bg-severity-error",
									},
								]}
							/>
							<span className="w-20 text-right font-mono text-xs tabular-nums text-foreground/80">
								{formatNumber(count)}
							</span>
							<span
								className={cn(
									"w-16 text-right font-mono text-xs tabular-nums",
									success ? "text-muted-foreground" : "text-severity-error",
								)}
							>
								{formatErrorRate(share)}
							</span>
						</div>
					)
				})}
			</div>
		</Panel>
	)
}

export interface WorkerRailDeploy {
	commitSha: string
	firstSeen: string
}

export function CloudflareWorkerRail({
	accountName,
	row,
	deploys,
	traced,
}: {
	accountName: string | null
	row: WorkerListRow | null
	deploys: ReadonlyArray<WorkerRailDeploy>
	/** Root-span and error counts from the matched service; null when nothing matched. */
	traced: { service: string; spans: number; errors: number } | null
}) {
	const { effectiveTimezone } = useTimezonePreference()
	return (
		<div className="flex flex-col">
			<DetailRail.Group label="Worker">
				<DetailRail.MetaRow icon={UserIcon} label="account" value={accountName} />
				<DetailRail.MetaRow
					icon={ServerIcon}
					label="durable objects"
					value={
						row === null
							? null
							: row.doRequests > 0
								? `${formatNumber(row.doRequests)} calls`
								: "none bound"
					}
				/>
				<DetailRail.MetaRow
					icon={StopwatchIcon}
					label="cpu p50"
					value={row && row.cpuP50Ms > 0 ? formatLatency(row.cpuP50Ms) : null}
				/>
			</DetailRail.Group>
			<DetailRail.Group label="Deploys in window">
				{deploys.length === 0 ? (
					<p className="text-2xs text-muted-foreground">No new version in this window.</p>
				) : (
					deploys.map((deploy) => (
						<DetailRail.MetaRow
							key={deploy.commitSha}
							icon={CodeIcon}
							label={deploy.commitSha.slice(0, 7)}
							value={formatTimeInTimezone(deploy.firstSeen, { timeZone: effectiveTimezone })}
						/>
					))
				)}
			</DetailRail.Group>
			<DetailRail.Group label="Traces">
				{traced === null ? (
					<p className="text-2xs leading-relaxed text-muted-foreground">
						No service with this name sends spans, so Cloudflare's counts are all there is.
					</p>
				) : (
					<>
						<DetailRail.MetaRow
							icon={PulseIcon}
							label="spans"
							value={formatNumber(traced.spans)}
						/>
						<DetailRail.MetaRow
							icon={PulseIcon}
							label="error spans"
							value={formatNumber(traced.errors)}
						/>
						<Link
							to="/services/$serviceName"
							params={{ serviceName: traced.service }}
							className="pt-1 font-mono text-xs text-primary hover:text-primary/80"
						>
							Open {traced.service}
						</Link>
					</>
				)}
			</DetailRail.Group>
		</div>
	)
}
