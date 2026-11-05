import type { SecurityAuditFinding } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { middleTruncate } from "@maple/views/ui/middle-truncate"
import { pressable } from "@maple/views/ui/pressable"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { hstack, vstack } from "@maple/views/ui/stack"
import { SEVERITY_FILL, severityIcon } from "../../errors/kit/severity"
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
import { securitySeverityBadge } from "./parts"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"

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
							: SEVERITY_FILL[bucket],
				className,
			),
		),
	])

/** Linear's priority marks: bars by severity, the warning glyph for critical, a dashed ring for
 * an unproven lead. Only critical is coloured, so the eye goes there first. `isQuiet` draws an
 * unconfirmed estimate a text step quieter; critical keeps its colour. */
export const bucketIcon = <M>(h: HtmlBuilder<M>, bucket: SeverityBucket, isQuiet = false): Html => {
	const quiet = isQuiet ? "text-foreground-subtle" : undefined
	switch (bucket) {
		case "critical":
			return severityIcon(h, "critical", 14)
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

/** One click per severity; a bucket with nothing in it stays out of the way unless it is picked. */
export const severityTabs = <M>(h: HtmlBuilder<M>, options: SeverityTabsOptions<M>): Html => {
	const total = Arr.reduce(SCORED_BUCKETS, 0, (sum, bucket) => sum + options.counts[bucket])
	return segmentedSelect<SeverityBucket | "all", M>(h, {
		size: "sm",
		ariaLabel: options.label,
		className: "max-w-full overflow-x-auto",
		value: options.active ?? "all",
		onChange: (value) => options.onPick(value === "all" ? null : value),
		options: [
			{ value: "all", label: `All ${total}` },
			...Arr.map(
				Arr.filter(
					SCORED_BUCKETS,
					(bucket) => options.counts[bucket] > 0 || options.active === bucket,
				),
				(bucket) => ({
					value: bucket,
					label: `${BUCKET_LABEL[bucket]} ${options.counts[bucket]}`,
					icon: bucketIcon(h, bucket),
				}),
			),
		],
	})
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
	const rowClass =
		"flex min-h-10 w-full min-w-0 items-center gap-3 py-1.5 pr-3 pl-8 text-left outline-none hover:bg-surface-sunken active:bg-surface-sunken focus-visible:bg-surface-strong focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
	// The title is what people read, so it gets the full line; where and why sit under it.
	const meta = [
		...(location === null
			? []
			: [
					middleTruncate(h, {
						text: location,
						tail: Math.min(28, location.length - location.lastIndexOf("/")),
						mono: true,
					}),
				]),
		...(note === null ? [] : [typography(h, { truncate: true, attributes: [h.Title(note)] }, [note])]),
	]
	const children = [
		bucketIcon(h, bucketOf(finding), isUnverified(finding)),
		vstack(h, { gap: "0.5", shrink: true, grow: true }, [
			typography(
				h,
				{
					size: "sm",
					truncate: true,
					className: cn(finding.verdict === "rejected" && "text-muted-foreground line-through"),
					attributes: [h.Title(finding.record.title)],
				},
				[finding.record.title],
			),
			...(meta.length === 0
				? []
				: [
						hstack(
							h,
							{
								gap: "2",
								shrink: true,
								className: "hidden text-xs text-muted-foreground md:flex",
							},
							meta,
						),
					]),
		]),
		hstack(h, { gap: "3", className: "shrink-0" }, [
			...(isUnverified(finding) ? [unverifiedChip(h)] : []),
			...options.trailing,
		]),
	]
	return h.li(
		[h.Key(`${finding.targetId}/${finding.fingerprint}`), h.Class("border-b border-border-subtle")],
		[
			"href" in options.open
				? h.a([h.Href(options.open.href), h.Class(rowClass)], children)
				: pressable(h, { onClick: options.open.onClick, className: rowClass }, children),
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
	const count = Arr.filter(rows, isUnverified).length
	return count === 0 ? [] : [trailingText(h, count === rows.length ? "unverified" : `${count} unverified`)]
}

/** Groups by bucket, each under a sticky header that folds its rows, as Linear groups by priority. */
export const findingGroups = <M>(h: HtmlBuilder<M>, options: FindingGroupsOptions<M>): Html =>
	h.div(
		[h.AriaLabel(options.label), h.Class("-mb-px flex flex-col")],
		Arr.map(options.sections, ({ bucket, rows }) => {
			const isCollapsed = options.collapsed.includes(bucket)
			const hint = SECTION_HINT[bucket]
			return h.section(
				[h.Key(bucket), h.AriaLabel(BUCKET_LABEL[bucket])],
				[
					pressable(
						h,
						{
							onClick: options.onToggle(bucket),
							className:
								"sticky top-0 z-[1] flex h-9 w-full items-center gap-2 border-b border-border-subtle bg-surface-strong px-3 text-left backdrop-blur hover:bg-muted active:bg-muted",
							attributes: [h.AriaExpanded(!isCollapsed)],
						},
						[
							icon(h, isCollapsed ? "ChevronRightIcon" : "ChevronDownIcon", {
								size: 12,
								className: "text-muted-foreground",
							}),
							bucketIcon(h, bucket),
							typography(h, { size: "sm", weight: "medium" }, [BUCKET_LABEL[bucket]]),
							typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [
								String(rows.length),
							]),
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
									Arr.map(rows, (finding) => findingRow(h, options.row(finding))),
								),
							]),
				],
			)
		}),
	)

/** Muted text for a trailing slot. */
export const trailingText = <M>(h: HtmlBuilder<M>, text: string, className?: string): Html =>
	h.span([h.Class(cn(typographyClass({ size: "xs", tone: "muted" }), className))], [text])
