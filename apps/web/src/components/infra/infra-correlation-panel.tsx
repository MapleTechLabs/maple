import type { ReactNode } from "react"
import { addMinutes, subMinutes } from "date-fns"
import { Link } from "@tanstack/react-router"

import { ExternalLinkIcon } from "@/components/icons"
import { formatForTinybird, relativeToAbsolute } from "@/lib/time-utils"
import { normalizeTimestampInput } from "@/lib/timezone-format"

import { NodeDetailChart, PodDetailChart } from "./k8s-detail-chart"
import { MetricStrip } from "./host-detail-chart"
import { getActiveInfraCorrelations, type InfraCorrelation } from "./infra-correlations"

const DEFAULT_PAD_MINUTES = 15
// Charts bucket at this width; metrics are sampled coarsely (hostmetrics /
// kubeletstats intervals), so a single span/log needs a padded window to have
// any points to draw.
const BUCKET_SECONDS = 60

/**
 * Builds a padded `[startTime, endTime]` window (in warehouse datetime format)
 * centred on a span/log anchor. For a span, pass its `durationMs` so the
 * window also covers the span's full extent. Falls back to a recent window if
 * the anchor can't be parsed.
 */
export function infraCorrelationWindow(
	anchor: string,
	opts?: { spanDurationMs?: number; padMinutes?: number },
): { startTime: string; endTime: string } {
	const date = new Date(normalizeTimestampInput(anchor))
	if (Number.isNaN(date.getTime())) {
		return relativeToAbsolute("30m")!
	}
	const pad = opts?.padMinutes ?? DEFAULT_PAD_MINUTES
	const end = addMinutes(new Date(date.getTime() + (opts?.spanDurationMs ?? 0)), pad)
	return {
		startTime: formatForTinybird(subMinutes(date, pad)),
		endTime: formatForTinybird(end),
	}
}

interface InfraCorrelationPanelProps {
	resourceAttributes: Record<string, string> | null | undefined
	startTime: string
	endTime: string
}

/**
 * Renders the live pod/node/host metrics for whichever infra identity the
 * opened span/log carries, plus a deep-link into the full infra detail page.
 * Maple's analogue of HyperDX's `DBInfraPanel`. Chart components self-fetch and
 * own their loading/error/empty states, so this stays thin.
 */
export function InfraCorrelationPanel({
	resourceAttributes,
	startTime,
	endTime,
}: InfraCorrelationPanelProps) {
	const correlations = getActiveInfraCorrelations(resourceAttributes)

	if (correlations.length === 0) {
		return (
			<div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
				No Kubernetes or host metadata on this record.
			</div>
		)
	}

	// One shared syncId across every chart so tooltips/cursors track together.
	const syncId = "infra-correlation"

	return (
		<div className="space-y-5">
			{correlations.map((correlation) => (
				<section key={`${correlation.kind}:${correlation.identifier}`} className="space-y-1">
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-baseline gap-2">
							<span className="text-[12px] font-medium text-foreground">
								{correlation.title}
							</span>
							<span className="truncate font-mono text-[11px] text-muted-foreground">
								{correlation.identifier}
							</span>
						</div>
						<CorrelationLink correlation={correlation} />
					</div>
					<div className="rounded-lg border bg-background">
						{renderCharts(correlation, startTime, endTime, syncId)}
					</div>
				</section>
			))}
		</div>
	)
}

function renderCharts(
	correlation: InfraCorrelation,
	startTime: string,
	endTime: string,
	syncId: string,
) {
	switch (correlation.kind) {
		case "pod":
			return correlation.charts.map((c) => (
				<LabeledChart key={c.metric} label={c.label}>
					<PodDetailChart
						podName={correlation.identifier}
						namespace={correlation.namespace}
						metric={c.metric}
						startTime={startTime}
						endTime={endTime}
						bucketSeconds={BUCKET_SECONDS}
						syncId={syncId}
					/>
				</LabeledChart>
			))
		case "node":
			return correlation.charts.map((c) => (
				<LabeledChart key={c.metric} label={c.label}>
					<NodeDetailChart
						nodeName={correlation.identifier}
						metric={c.metric}
						startTime={startTime}
						endTime={endTime}
						bucketSeconds={BUCKET_SECONDS}
						syncId={syncId}
					/>
				</LabeledChart>
			))
		case "host":
			return correlation.charts.map((c) => (
				<MetricStrip
					key={c.metric}
					label={c.label}
					hostName={correlation.identifier}
					metric={c.metric}
					startTime={startTime}
					endTime={endTime}
					bucketSeconds={BUCKET_SECONDS}
					syncId={syncId}
				/>
			))
	}
}

/**
 * Label-above-chart wrapper mirroring `MetricStrip`'s narrow-width layout, so
 * pod/node charts (which render bare) read consistently with the host strips.
 */
function LabeledChart({ label, children }: { label: string; children: ReactNode }) {
	return (
		<section className="border-t px-1 py-3 first:border-t-0">
			<div className="px-2 text-[12px] font-medium text-foreground">{label}</div>
			<div className="mt-2">{children}</div>
		</section>
	)
}

/** Typed SPA deep-link into the matching infra detail route, per kind. */
function CorrelationLink({ correlation }: { correlation: InfraCorrelation }) {
	const className =
		"inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
	const content = (
		<>
			View in Infrastructure
			<ExternalLinkIcon size={11} />
		</>
	)

	switch (correlation.kind) {
		case "pod":
			return (
				<Link
					to="/infra/kubernetes/pods/$podName"
					params={{ podName: correlation.identifier }}
					search={correlation.namespace ? { namespace: correlation.namespace } : {}}
					className={className}
				>
					{content}
				</Link>
			)
		case "node":
			return (
				<Link
					to="/infra/kubernetes/nodes/$nodeName"
					params={{ nodeName: correlation.identifier }}
					className={className}
				>
					{content}
				</Link>
			)
		case "host":
			return (
				<Link to="/infra/$hostName" params={{ hostName: correlation.identifier }} className={className}>
					{content}
				</Link>
			)
	}
}
