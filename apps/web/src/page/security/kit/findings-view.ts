import type { SecurityAuditFinding } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { tableCell, tableRow } from "../../../ui/table"
import { locationOf } from "./format"
import {
	BUCKET_LABEL,
	type BucketCounts,
	confidenceOf,
	type SeverityBucket,
	SCORED_BUCKETS,
} from "./findings"
import { SECURITY_SEVERITY_FILL, securitySeverityBadge } from "./parts"

// The severity tiles, section headers and row cells the run page and the Findings tab share.

/** A dot per bucket: the severity ramp, a hollow ring for info, dashed for an unproven lead. */
export const bucketDot = <M>(h: HtmlBuilder<M>, bucket: SeverityBucket, className?: string): Html =>
	h.span([
		h.AriaHidden(true),
		h.Class(
			cn(
				"inline-block size-2.5 shrink-0 rounded-full",
				bucket === "informational"
					? "border-2 border-muted-foreground/60"
					: bucket === "needs_validation"
						? "border-2 border-dashed border-muted-foreground"
						: bucket === "rejected"
							? "bg-muted-foreground/30"
							: SECURITY_SEVERITY_FILL[bucket],
				className,
			),
		),
	])

export const bucketBadge = <M>(h: HtmlBuilder<M>, bucket: SeverityBucket): Html =>
	bucket === "needs_validation"
		? badge(h, { variant: "outline", className: "border-dashed" }, ["Needs validation"])
		: bucket === "rejected"
			? badge(h, { variant: "muted", className: "line-through" }, ["Rejected"])
			: securitySeverityBadge(h, bucket)

export type SeverityTilesOptions<M> = Readonly<{
	counts: BucketCounts
	active: SeverityBucket | null
	onPick: (bucket: SeverityBucket) => M
	label: string
}>

/** One tile per bucket but rejected: the count, and a toggle that narrows the list to it. */
export const severityTiles = <M>(h: HtmlBuilder<M>, options: SeverityTilesOptions<M>): Html =>
	h.div(
		[
			h.Role("group"),
			h.AriaLabel(options.label),
			h.Class("grid grid-cols-3 gap-px overflow-hidden rounded-md border bg-border md:grid-cols-6"),
		],
		SCORED_BUCKETS.map((bucket) => {
			const count = options.counts[bucket]
			const isActive = options.active === bucket
			const isDimmed = options.active !== null && !isActive
			return h.button(
				[
					h.Key(bucket),
					h.Type("button"),
					h.AriaPressed(String(isActive)),
					h.AriaLabel(`${BUCKET_LABEL[bucket]}: ${count}`),
					h.Disabled(count === 0 && !isActive),
					h.OnClick(options.onPick(bucket)),
					h.Class(
						cn(
							"flex min-w-0 flex-col items-start gap-1.5 bg-card px-4 py-3 text-left transition-colors",
							"hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-card",
							isActive && "bg-muted hover:bg-muted",
						),
					),
				],
				[
					h.span(
						[
							h.Class(
								cn(
									"flex items-center gap-2 text-xs",
									isActive ? "text-foreground" : "text-muted-foreground",
								),
							),
						],
						[bucketDot(h, bucket), BUCKET_LABEL[bucket]],
					),
					h.span(
						[
							h.Class(
								cn(
									"font-mono text-2xl tabular-nums",
									count === 0 || isDimmed ? "text-muted-foreground/60" : "text-foreground",
								),
							),
						],
						[String(count)],
					),
				],
			)
		}),
	)

export type SectionHeaderOptions<M> = Readonly<{
	bucket: SeverityBucket
	count: number
	isCollapsed: boolean
	onToggle: M
	colSpan: number
	hint: string | null
}>

/** A section's header row: the whole row toggles the section open and closed. */
export const sectionHeaderRow = <M>(h: HtmlBuilder<M>, options: SectionHeaderOptions<M>): Html =>
	tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.button(
						[
							h.Type("button"),
							h.AriaExpanded(!options.isCollapsed),
							h.OnClick(options.onToggle),
							h.Class("flex w-full items-center gap-2.5 px-2 py-2 text-left"),
						],
						[
							icon(h, options.isCollapsed ? "ChevronRightIcon" : "ChevronDownIcon", {
								size: 14,
								className: "text-muted-foreground",
							}),
							bucketDot(h, options.bucket),
							h.span([h.Class("text-sm font-medium")], [BUCKET_LABEL[options.bucket]]),
							h.span(
								[h.Class("font-mono text-xs tabular-nums text-muted-foreground")],
								[String(options.count)],
							),
							...(options.hint === null
								? []
								: [
										h.span(
											[
												h.Class(
													"ml-auto hidden text-xs text-muted-foreground md:inline",
												),
											],
											[options.hint],
										),
									]),
						],
					),
				],
				"bg-muted/40 p-0",
				[h.Attribute("colspan", String(options.colSpan))],
			),
		],
		"hover:bg-transparent",
		[h.Key(`section-${options.bucket}`)],
	)

/** The title, struck through when disproved, over the first trace or evidence location. */
export const findingTitle = <M>(h: HtmlBuilder<M>, finding: SecurityAuditFinding): Html =>
	h.span(
		[h.Class("flex min-w-0 flex-col gap-0.5")],
		[
			h.span(
				[
					h.Class(
						cn(
							"truncate text-sm",
							finding.verdict === "rejected" && "text-muted-foreground line-through",
						),
					),
				],
				[finding.record.title],
			),
			h.span(
				[h.Class("truncate font-mono text-xs text-muted-foreground")],
				[locationOf(finding.record) ?? ""],
			),
		],
	)

const CONFIDENCE_LABEL = { low: "Low", medium: "Medium", high: "High" } as const

export const confidenceText = <M>(h: HtmlBuilder<M>, finding: SecurityAuditFinding): Html => {
	const score = confidenceOf(finding)
	return score === null
		? h.span([h.Class("text-xs text-muted-foreground")], [""])
		: h.span(
				[h.Class(cn("text-xs", score === "high" ? "text-foreground" : "text-muted-foreground"))],
				[CONFIDENCE_LABEL[score]],
			)
}

/** Copy for the hint on each section, where the bucket needs one. */
export const SECTION_HINT = {
	critical: null,
	high: null,
	medium: null,
	low: null,
	informational: null,
	needs_validation: "Read from source, not run. Each has a check you can run.",
	rejected: "A second model disproved these. Kept for the record.",
} satisfies Record<SeverityBucket, string | null>
