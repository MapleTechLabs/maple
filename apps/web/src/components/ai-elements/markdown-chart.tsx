import { lazy, Suspense, useMemo, type ReactNode } from "react"

import { ChartSkeleton } from "@maple/ui/components/charts"

import { normalizeUnit, parseChartSpec, type ChartSpec } from "./chart-spec"

/**
 * The chart Streamdown renders for a ```chart fence in an assistant reply.
 *
 * Registered as a custom renderer rather than a `code` component override, so
 * the fence keeps its own streaming state: `isIncomplete` stays true until the
 * closing fence lands, which is the difference between a skeleton and a plot
 * redrawn on every row as the rows arrive.
 *
 * The plot itself is the query builder's — same series colours, same units,
 * same tooltip as the chart these numbers get on a dashboard. See
 * `chart-spec.ts` for what a fence has to hold to become one.
 */

/** The charts pull in the plotting runtime, which a reply without one should not pay for. */
const LazyChartPlot = lazy(() => import("./chart-plot").then((m) => ({ default: m.ChartPlot })))

const PLOT_HEIGHT = "h-[160px] w-full"

interface MarkdownChartProps {
	readonly code: string
	readonly isIncomplete: boolean
	readonly language: string
}

export function MarkdownChart({ code, isIncomplete }: MarkdownChartProps) {
	const spec = useMemo(() => parseChartSpec(code), [code])

	// A fence still streaming has no shape to check yet, so an unparsed one is a
	// skeleton rather than the raw JSON a finished one falls back to.
	if (spec === null && isIncomplete) {
		return (
			<ChartFrame title={null}>
				<ChartSkeleton variant="line" className={PLOT_HEIGHT} />
			</ChartFrame>
		)
	}

	// Model output that is not a chart after all. Left visible as text — a bad
	// payload should be debuggable, not silently missing.
	if (spec === null) {
		return (
			<pre className="my-3 overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
				<code>{code}</code>
			</pre>
		)
	}

	return (
		<ChartFrame title={spec.title ?? null}>
			<Suspense fallback={<ChartSkeleton variant={skeletonVariant(spec)} className={PLOT_HEIGHT} />}>
				<LazyChartPlot spec={spec} unit={normalizeUnit(spec.unit)} className={PLOT_HEIGHT} />
			</Suspense>
		</ChartFrame>
	)
}

const skeletonVariant = (spec: ChartSpec) => (spec.type === "ranked" ? "hbar" : spec.type)

/**
 * The card a chart sits in — the table's frame, so a chart and a table in the
 * same reply agree on their border, radius and rhythm.
 */
function ChartFrame({ title, children }: { title: string | null; children: ReactNode }) {
	return (
		<figure className="my-3 space-y-2 rounded-lg border border-border bg-card p-3">
			{title ? (
				<figcaption className="text-[11px] font-medium text-muted-foreground">{title}</figcaption>
			) : null}
			{children}
		</figure>
	)
}
