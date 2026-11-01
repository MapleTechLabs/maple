import type { SecurityAuditFinding } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { middleTruncate } from "../../../ui/middle-truncate"
import { severityIcon } from "../../errors/kit/severity"
import { locationOf } from "./format"
import {
	BUCKET_LABEL,
	bucketOf,
	isUnverified,
	type BucketCounts,
	type FindingSection,
	type SeverityBucket,
	SCORED_BUCKETS,
} from "./findings"
import { SECURITY_SEVERITY_FILL, securitySeverityBadge } from "./parts"

// The findings list the run page and the Findings tab share, laid out like Linear's issue list:
// severity tabs on top, collapsible groups, one dense line per finding.

/** A dot per bucket: the severity ramp, a hollow ring for info, dashed for an unproven lead. */
export const bucketDot = <M>(h: HtmlBuilder<M>, bucket: SeverityBucket, className?: string): Html =>
	h.span([
		h.AriaHidden(true),
		h.Class(
			cn(
				"inline-block size-2.5 shrink-0 rounded-full",
				bucket === "informational"
					? "border-2 border-foreground-subtle"
					: bucket === "needs_validation"
						? "border-2 border-dashed border-muted-foreground"
						: bucket === "rejected"
							? "bg-foreground-faint"
							: SECURITY_SEVERITY_FILL[bucket],
				className,
			),
		),
	])

/** Linear's priority marks: bars by severity, the warning glyph for critical, a dashed ring for
 * an unproven lead. Only critical is coloured, so the eye goes there first. */
/** `isQuiet` draws a severity a step quieter, for an estimate that is not confirmed yet. */
export const bucketIcon = <M>(h: HtmlBuilder<M>, bucket: SeverityBucket, isQuiet = false): Html => {
	const quiet = isQuiet ? "text-foreground-subtle" : undefined
	switch (bucket) {
		case "critical":
			return severityIcon(h, "critical", 14, quiet)
		case "high":
		case "medium":
		case "low":
			return severityIcon(h, bucket, 14, quiet ?? "text-foreground")
		case "informational":
			return severityIcon(h, null, 14, quiet)
		case "needs_validation":
			return h.span(
				[
					h.Role("img"),
					h.AriaLabel("Needs validation"),
					h.Class("inline-flex size-3.5 items-center justify-center"),
				],
				[
					h.span([
						h.Class("size-3 rounded-full border-[1.5px] border-dashed border-muted-foreground"),
					]),
				],
			)
		case "rejected":
			return icon(h, "CircleXmarkIcon", { size: 14, className: "text-muted-foreground" })
	}
}

/** The severity a finding reads at: a scored lead says its severity is an estimate. */
export const findingBadge = <M>(h: HtmlBuilder<M>, finding: SecurityAuditFinding): Html =>
	isUnverified(finding)
		? badge(h, { variant: "outline", className: "border-dashed" }, [
				`${BUCKET_LABEL[bucketOf(finding)]} · unverified`,
			])
		: bucketBadge(h, bucketOf(finding))

/** A scored lead's mark: its severity, quieter and labelled, until something proves it. */
export const unverifiedChip = <M>(h: HtmlBuilder<M>): Html =>
	h.span(
		[
			h.Title("Severity estimated from the source; not proven by running the code"),
			h.Class(
				"rounded-sm border border-dashed border-foreground-subtle px-1.5 py-px text-2xs text-muted-foreground",
			),
		],
		["Unverified"],
	)

export const bucketBadge = <M>(h: HtmlBuilder<M>, bucket: SeverityBucket): Html =>
	bucket === "needs_validation"
		? badge(h, { variant: "outline", className: "border-dashed" }, ["Needs validation"])
		: bucket === "rejected"
			? badge(h, { variant: "muted", className: "line-through" }, ["Rejected"])
			: securitySeverityBadge(h, bucket)

export type SeverityTabsOptions<M> = Readonly<{
	counts: BucketCounts
	active: SeverityBucket | null
	/** Null is "All". */
	onPick: (bucket: SeverityBucket | null) => M
	label: string
}>

const tabButton = <M>(
	h: HtmlBuilder<M>,
	isActive: boolean,
	onClick: M,
	key: string,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.button(
		[
			h.Key(key),
			h.Type("button"),
			h.Role("tab"),
			h.AriaSelected(isActive),
			h.OnClick(onClick),
			h.Class(
				cn(
					"flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
					isActive
						? "border-border bg-muted font-medium text-foreground"
						: "border-transparent text-muted-foreground hover:bg-surface-sunken active:bg-surface-sunken hover:text-foreground active:text-foreground",
				),
			),
		],
		children,
	)

const tabCount = <M>(h: HtmlBuilder<M>, count: number): Html =>
	h.span([h.Class("font-mono tabular-nums text-muted-foreground")], [String(count)])

/** One click per severity; a bucket with nothing in it stays out of the way unless it is picked. */
export const severityTabs = <M>(h: HtmlBuilder<M>, options: SeverityTabsOptions<M>): Html => {
	const total = SCORED_BUCKETS.reduce((sum, bucket) => sum + options.counts[bucket], 0)
	return h.div(
		[h.Role("tablist"), h.AriaLabel(options.label), h.Class("flex items-center gap-1 overflow-x-auto")],
		[
			tabButton(h, options.active === null, options.onPick(null), "all", ["All", tabCount(h, total)]),
			...SCORED_BUCKETS.filter((bucket) => options.counts[bucket] > 0 || options.active === bucket).map(
				(bucket) =>
					tabButton(h, options.active === bucket, options.onPick(bucket), bucket, [
						bucketIcon(h, bucket),
						BUCKET_LABEL[bucket],
						tabCount(h, options.counts[bucket]),
					]),
			),
		],
	)
}

/** Copy for the hint on each group, where the bucket needs one. */
export const SECTION_HINT = {
	critical: null,
	high: null,
	medium: null,
	low: null,
	informational: null,
	needs_validation: "No severity estimate",
	rejected: "Disproved by a second model",
} satisfies Record<SeverityBucket, string | null>

export type FindingRowOptions<M> = Readonly<{
	finding: SecurityAuditFinding
	/** Opens the finding: a link to its page or a message for a side sheet. */
	open: Readonly<{ href: string }> | Readonly<{ onClick: M }>
	/** Right-aligned metadata, Linear's labels and dates. */
	trailing: ReadonlyArray<Html>
}>

/** Why a lead is unproven, or why a claim was disproved. */
const noteOf = (finding: SecurityAuditFinding): string | null =>
	finding.record.verdict === "needs_validation"
		? (finding.record.blockers[0] ?? null)
		: finding.record.verdict === "rejected"
			? finding.record.reason
			: null

/** One line per finding; the whole line is the target. */
const findingRow = <M>(h: HtmlBuilder<M>, options: FindingRowOptions<M>): Html => {
	const { finding } = options
	const location = locationOf(finding.record)
	const note = noteOf(finding)
	const attributes: ReadonlyArray<Attribute<M>> = [
		h.Class(
			"flex h-10 w-full min-w-0 items-center gap-3 pr-3 pl-8 text-left outline-none hover:bg-surface-sunken active:bg-surface-sunken focus-visible:bg-surface-strong focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
		),
	]
	const children = [
		bucketIcon(h, bucketOf(finding), isUnverified(finding)),
		h.span(
			[
				h.Class(
					cn(
						"min-w-0 shrink truncate text-sm",
						finding.verdict === "rejected" && "text-muted-foreground line-through",
					),
				),
				h.Title(finding.record.title),
			],
			[finding.record.title],
		),
		...(location === null
			? []
			: [
					middleTruncate(h, {
						text: location,
						tail: Math.min(28, location.length - location.lastIndexOf("/")),
						mono: true,
						className:
							"hidden min-w-0 max-w-[40%] shrink-[2] text-xs text-muted-foreground md:flex",
					}),
				]),
		...(note === null
			? []
			: [
					h.span(
						[
							h.Class(
								"hidden min-w-0 shrink-[3] truncate text-xs text-muted-foreground xl:inline",
							),
							h.Title(note),
						],
						[note],
					),
				]),
		h.span(
			[h.Class("ml-auto flex shrink-0 items-center gap-3")],
			[...(isUnverified(finding) ? [unverifiedChip(h)] : []), ...options.trailing],
		),
	]
	return h.li(
		[h.Key(`${finding.targetId}/${finding.fingerprint}`), h.Class("border-b border-border-subtle")],
		[
			"href" in options.open
				? h.a([h.Href(options.open.href), ...attributes], children)
				: h.button([h.Type("button"), h.OnClick(options.open.onClick), ...attributes], children),
		],
	)
}

export type FindingGroupsOptions<M> = Readonly<{
	sections: ReadonlyArray<FindingSection>
	collapsed: ReadonlyArray<SeverityBucket>
	onToggle: (bucket: SeverityBucket) => M
	row: (finding: SecurityAuditFinding) => FindingRowOptions<M>
	label: string
}>

/** "unverified" when a whole group is estimates, "2 unverified" when some are, nothing otherwise. */
const unverifiedNote = <M>(
	h: HtmlBuilder<M>,
	rows: ReadonlyArray<SecurityAuditFinding>,
): ReadonlyArray<Html> => {
	const count = rows.filter(isUnverified).length
	return count === 0 ? [] : [trailingText(h, count === rows.length ? "unverified" : `${count} unverified`)]
}

/** Groups by bucket, each under a sticky header that folds its rows, as Linear groups by priority. */
export const findingGroups = <M>(h: HtmlBuilder<M>, options: FindingGroupsOptions<M>): Html =>
	h.div(
		[h.AriaLabel(options.label), h.Class("-mb-px flex flex-col")],
		options.sections.map(({ bucket, rows }) => {
			const isCollapsed = options.collapsed.includes(bucket)
			const hint = SECTION_HINT[bucket]
			return h.section(
				[h.Key(bucket), h.AriaLabel(BUCKET_LABEL[bucket])],
				[
					h.button(
						[
							h.Type("button"),
							h.AriaExpanded(!isCollapsed),
							h.OnClick(options.onToggle(bucket)),
							h.Class(
								"sticky top-0 z-[1] flex h-9 w-full items-center gap-2 border-b border-border-subtle bg-surface-strong px-3 text-left backdrop-blur hover:bg-muted active:bg-muted",
							),
						],
						[
							icon(h, isCollapsed ? "ChevronRightIcon" : "ChevronDownIcon", {
								size: 12,
								className: "text-muted-foreground",
							}),
							bucketIcon(h, bucket),
							h.span([h.Class("text-sm font-medium")], [BUCKET_LABEL[bucket]]),
							h.span(
								[h.Class("font-mono text-xs tabular-nums text-muted-foreground")],
								[String(rows.length)],
							),
							...unverifiedNote(h, rows),
							...(hint === null
								? []
								: [
										h.span(
											[
												h.Class(
													"ml-auto hidden text-xs text-muted-foreground md:inline",
												),
											],
											[hint],
										),
									]),
						],
					),
					...(isCollapsed
						? []
						: [
								h.ul(
									[h.Class("flex flex-col")],
									rows.map((finding) => findingRow(h, options.row(finding))),
								),
							]),
				],
			)
		}),
	)

/** Muted text for a trailing slot. */
export const trailingText = <M>(h: HtmlBuilder<M>, text: string, className?: string): Html =>
	h.span([h.Class(cn("text-xs text-muted-foreground", className))], [text])
