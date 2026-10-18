import type { CodeReviewCiRun } from "@maple/domain/http"
import { ciResultLabel, ciResultTone } from "@maple/web/components/code-review/ci/ci-format"
import { formatRelativeShortFrom, formatRelativeFrom } from "@maple/ui/lib/time-format"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { linkButton } from "../../../ui/button"
import { badge } from "../../../ui/display"

// Small pieces the Code Review tabs share: `SectionHeading` (title variant), `BulletList`,
// `RelativeTime tooltip="title"`, `CiResultBadge` and `TraceLink`.

/** `<SectionHeading title as>` without actions. */
export const sectionHeading = <M>(h: HtmlBuilder<M>, title: string, as: "h2" | "h3" = "h2"): Html =>
	h.div(
		[h.Class("flex items-baseline gap-2.5")],
		[(as === "h2" ? h.h2 : h.h3)([h.Class("text-sm font-medium text-foreground")], [title])],
	)

/** The sheet's `Section`. */
export const section = <M>(h: HtmlBuilder<M>, title: string, children: ReadonlyArray<Html>): Html =>
	h.section([h.Class("flex flex-col gap-2.5")], [sectionHeading(h, title, "h3"), ...children])

export const bulletList = <M>(h: HtmlBuilder<M>, items: ReadonlyArray<string>): Html =>
	h.ul(
		[
			h.Class(
				"flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground marker:text-muted-foreground/50",
			),
		],
		items.map((item) => h.li([], [item])),
	)

export type RelativeTimeOptions = Readonly<{
	epochMs: number
	nowMs: number
	timeZone: string
	variant?: "long" | "short"
	className?: string
}>

/** `<RelativeTime tooltip="title">`: the relative label, the absolute time as its native title. */
export const relativeTime = <M>(h: HtmlBuilder<M>, options: RelativeTimeOptions): Html =>
	h.time(
		[
			...(options.className === undefined ? [] : [h.Class(options.className)]),
			h.Attribute("datetime", new Date(options.epochMs).toISOString()),
			h.Title(
				formatTimestampInTimezone(options.epochMs, { timeZone: options.timeZone, withYear: true }),
			),
		],
		[
			options.variant === "short"
				? formatRelativeShortFrom(options.epochMs, options.nowMs)
				: formatRelativeFrom(options.epochMs, options.nowMs),
		],
	)

/** A run's result; a rerun says which attempt it was. */
export const ciResultBadge = <M>(h: HtmlBuilder<M>, result: string, attempt = 1, className?: string): Html =>
	h.span(
		[h.Class(cn("inline-flex items-center gap-1.5", className))],
		[
			badge(h, { size: "sm", className: TONE_SOFT[ciResultTone(result)] }, [ciResultLabel(result)]),
			...(attempt > 1
				? [h.span([h.Class("text-xs text-muted-foreground")], [`attempt ${attempt}`])]
				: []),
		],
	)

/** The trace page, narrowed to the run's start so the lookup prunes partitions. */
export const traceLink = <M>(h: HtmlBuilder<M>, run: CodeReviewCiRun, className?: string): Html =>
	linkButton(
		h,
		{
			variant: "ghost",
			size: "xs",
			className,
			href: hrefOf(
				AppRoute.Trace({
					traceId: run.traceId,
					search: { t: new Date(run.startedAt).toISOString() },
				}),
			),
		},
		["View trace"],
	)
