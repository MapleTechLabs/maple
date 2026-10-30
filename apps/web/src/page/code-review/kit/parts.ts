import type { CodeReviewCiRun } from "@maple/domain/http"
import { ciResultLabel, ciResultTone } from "../../../components/code-review/ci/ci-format"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { linkButton } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { sectionHeading } from "../../kit/section-heading"

// Small pieces the Code Review tabs share: the sheet `Section`, `BulletList`, `CiResultBadge` and
// `TraceLink`.

/** The sheet's `Section`. */
export const section = <M>(h: HtmlBuilder<M>, title: string, children: ReadonlyArray<Html>): Html =>
	h.section([h.Class("flex flex-col gap-2.5")], [sectionHeading(h, { title, as: "h3" }), ...children])

export const bulletList = <M>(h: HtmlBuilder<M>, items: ReadonlyArray<string>): Html =>
	h.ul(
		[
			h.Class(
				"flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground marker:text-foreground-faint",
			),
		],
		items.map((item) => h.li([], [item])),
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

const DAY_MS = 24 * 60 * 60 * 1000

/** `traces` drops a span 30 days after its UTC day; `ci_runs` keeps a year, so older runs have no trace. */
export const traceKept = (startedAtMs: number, nowMs: number): boolean =>
	nowMs < Math.floor(startedAtMs / DAY_MS) * DAY_MS + 30 * DAY_MS

/** The trace page, narrowed to the run's start so the lookup prunes partitions; none once expired. */
export const traceLink = <M>(
	h: HtmlBuilder<M>,
	run: CodeReviewCiRun,
	nowMs: number,
	className?: string,
): ReadonlyArray<Html> =>
	!traceKept(run.startedAt, nowMs)
		? []
		: [
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
				),
			]
