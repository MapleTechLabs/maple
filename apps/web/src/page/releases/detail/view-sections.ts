import type { ErrorIssueDocument, VcsCommitRangeResponse } from "@maple/domain/http"
import {
	countLabel,
	EMPTY_VALUE,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
	pluralize,
} from "@maple/ui/lib/format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import {
	ROLLOUT_COMPLETE_SHARE,
	shortReleaseLabel,
	type ReleaseGroup,
	type ReleaseServiceImpact,
} from "../../../components/releases/release-model"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { badge } from "../../../ui/display"
import { emptyMessage } from "../../../ui/empty"
import { listRow } from "../../../ui/list-row"
import { panel, panelBody, panelHeader } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { truncatedText } from "../../../ui/truncated-text"
import { serviceDot } from "../../../ui/values"
import { relativeTime } from "../../kit/relative-time"
import { commitAvatar, firstLine, releaseHealthFigure, releaseHref } from "../kit"
import { type Overlays, releaseHealthPill } from "../overlays-view"

// `ReleaseDeployOverview`'s sections, `ReleaseChangeset` and `IssueList` + `IssueLine`.

export type Clock = Readonly<{ nowMs: number; timeZone: string }>
type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

/** `SectionCard`. */
export const sectionCard = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ title: string; action?: Html; className?: string }>,
	children: ReadonlyArray<Html>,
): Html =>
	panel(h, { className: options.className }, [
		panelHeader(h, { title: options.title, action: options.action }),
		panelBody(h, children),
	])

export const deploySummary = <M>(h: HtmlBuilder<M>, group: ReleaseGroup, clock: Clock): Html => {
	const services = new Set(group.services.map((impact) => impact.serviceName)).size
	const flagged = group.services.filter((impact) => impact.health !== "healthy").length
	return h.div(
		[h.Class("flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 text-xs text-muted-foreground")],
		[
			h.span(
				[],
				[
					"first seen",
					" ",
					relativeTime(h, {
						value: group.firstSeen,
						nowMs: clock.nowMs,
						timeZone: clock.timeZone,
						variant: "orDate",
						tooltip: "title",
						className: "text-foreground",
					}),
				],
			),
			h.span(
				[],
				[
					h.span([h.Class("font-medium tabular-nums text-foreground")], [String(services)]),
					" ",
					pluralize(services, "service"),
				],
			),
			h.span(
				[],
				[
					h.span(
						[h.Class("font-medium tabular-nums text-foreground")],
						[formatNumber(group.spanCount)],
					),
					" ",
					"requests",
				],
			),
			...(flagged > 0
				? [h.span([h.Class("text-severity-warn")], [countLabel(flagged, "service"), " flagged"])]
				: []),
		],
	)
}

const beforeAfter = <M>(
	h: HtmlBuilder<M>,
	before: number | undefined,
	after: number,
	format: (value: number) => string,
	tone?: "error" | "warn",
): Html =>
	h.span(
		[h.Class("inline-flex items-baseline gap-1 font-mono text-xs tabular-nums")],
		[
			...(before === undefined
				? []
				: [h.span([h.Class("text-3xs text-muted-foreground/70")], [format(before), " →"])]),
			h.span(
				[
					h.Class(
						cn(
							tone === "error" && "text-severity-error",
							tone === "warn" && "text-severity-warn",
						),
					),
				],
				[format(after)],
			),
		],
	)

const serviceRow = <M>(
	h: HtmlBuilder<M>,
	impact: ReleaseServiceImpact,
	environments: ReadonlyArray<string> | undefined,
	timeSearch: TimeSearch,
	overlays: Overlays<M>,
): Html =>
	tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.a(
						[
							h.Href(
								releaseHref(impact.commitSha, {
									...timeSearch,
									service: impact.serviceName,
									environments:
										environments ??
										(impact.environment ? [impact.environment] : undefined),
								}),
							),
							h.Class("inline-flex items-center gap-2 hover:underline"),
						],
						[
							serviceDot(h, { serviceName: impact.serviceName }),
							impact.serviceName,
							...(impact.environment && !environments?.length
								? [h.span([h.Class("text-muted-foreground/70")], [impact.environment])]
								: []),
							...(impact.health === "healthy"
								? []
								: [
										releaseHealthPill(
											h,
											overlays,
											`release-pill-${`${impact.serviceName}-${impact.environment}`.replace(/[^A-Za-z0-9_-]/g, "_")}`,
											impact.health,
											releaseHealthFigure(impact),
										),
									]),
						],
					),
				],
				"pl-4",
			),
			tableCell(
				h,
				[impact.baseline ? shortReleaseLabel(impact.baseline.commitSha) : EMPTY_VALUE],
				"font-mono text-2xs text-muted-foreground",
			),
			tableCell(h, [formatNumber(impact.spanCount)], "text-right font-mono tabular-nums"),
			tableCell(h, [
				beforeAfter(
					h,
					impact.baseline?.errorRate,
					impact.errorRate,
					formatErrorRate,
					impact.health === "regressed" ? "error" : undefined,
				),
			]),
			tableCell(h, [
				beforeAfter(
					h,
					impact.baseline?.p95LatencyMs,
					impact.p95LatencyMs,
					formatLatency,
					impact.health === "watch" ? "warn" : undefined,
				),
			]),
			tableCell(
				h,
				[impact.share === undefined ? EMPTY_VALUE : formatPercent(impact.share)],
				cn(
					"pr-4 text-right font-mono tabular-nums",
					impact.share !== undefined && impact.share > 0 && impact.share < ROLLOUT_COMPLETE_SHARE
						? "text-primary"
						: "text-muted-foreground",
				),
			),
		],
		"border-border/60",
		[h.Key(`${impact.serviceName}:${impact.environment}`)],
	)

export const deployServices = <M>(
	h: HtmlBuilder<M>,
	group: ReleaseGroup,
	environments: ReadonlyArray<string> | undefined,
	timeSearch: TimeSearch,
	overlays: Overlays<M>,
): Html => {
	const rows = group.services.toSorted(
		(a, b) =>
			Number(a.health === "healthy") - Number(b.health === "healthy") || b.spanCount - a.spanCount,
	)
	return sectionCard(
		h,
		{
			title: "Services",
			action: h.span(
				[h.Class("text-2xs text-muted-foreground/70")],
				["against the version each replaced"],
			),
		},
		[
			table(h, { size: "sm" }, [
				tableHeader(h, [
					tableRow(
						h,
						[
							tableHead(h, ["Service"], "pl-4"),
							tableHead(h, ["Replaced"]),
							tableHead(h, ["Requests"], "text-right"),
							tableHead(h, ["Error rate"]),
							tableHead(h, ["p95"]),
							tableHead(h, ["Live share"], "pr-4 text-right"),
						],
						eyebrowVariants(),
					),
				]),
				tableBody(
					h,
					rows.map((impact) => serviceRow(h, impact, environments, timeSearch, overlays)),
				),
			]),
		],
	)
}

/** `(#1083)` at the end of a squash-merge subject, linked to the pull request. */
const pullRequestUrl = (subject: string, commitUrl: string): { number: string; url: string } | undefined => {
	const match = subject.match(/\(#(\d+)\)\s*$/)
	const repoUrl = commitUrl.match(/^(.*)\/commit\/[0-9a-f]+$/i)?.[1]
	if (match?.[1] === undefined || repoUrl === undefined) return undefined
	return { number: match[1], url: `${repoUrl}/pull/${match[1]}` }
}

export type ChangesetState =
	| { readonly _tag: "NoBase" }
	| { readonly _tag: "NotShas" }
	| { readonly _tag: "Loading"; readonly base: string }
	| { readonly _tag: "Unavailable"; readonly base: string }
	| { readonly _tag: "Loaded"; readonly base: string; readonly range: VcsCommitRangeResponse }

/** `ReleaseChangeset`. */
export const releaseChangeset = <M>(h: HtmlBuilder<M>, state: ChangesetState, clock: Clock): Html => {
	if (state._tag === "NoBase")
		return sectionCard(h, { title: "What shipped" }, [
			emptyMessage(h, {}, ["No earlier version in this window to compare against."]),
		])
	if (state._tag === "NotShas")
		return sectionCard(h, { title: "What shipped" }, [
			emptyMessage(h, {}, [
				"These versions are not commit shas, so the commits between them are unknown.",
			]),
		])
	const action = h.span(
		[h.Class("text-2xs text-muted-foreground/70")],
		["since ", h.span([h.Class("font-mono")], [shortReleaseLabel(state.base)])],
	)
	if (state._tag === "Loading")
		return sectionCard(h, { title: "What shipped", action }, [
			h.div([h.Class("space-y-2 p-3")], [skeleton(h, "h-4 w-3/4"), skeleton(h, "h-4 w-1/2")]),
		])
	if (state._tag === "Unavailable")
		return sectionCard(h, { title: "What shipped", action }, [
			emptyMessage(h, {}, [
				"Both versions need to be commits of a connected repository's tracked branch to list what changed between them.",
			]),
		])
	const { range } = state
	const hidden = range.totalCount - range.commits.length
	return sectionCard(
		h,
		{
			title: `What shipped · ${range.totalCount}${range.truncated ? "+" : ""} ${pluralize(range.totalCount, "commit")}`,
			action,
		},
		[
			h.div(
				[h.Class("max-h-80 overflow-y-auto")],
				[
					...range.commits.map((commit) => {
						const subject = firstLine(commit.message)
						const pr = pullRequestUrl(subject, commit.htmlUrl)
						const author = commit.authorLogin ?? commit.authorName ?? "Unknown author"
						return h.div(
							[
								h.Key(commit.sha),
								h.Class(
									"flex items-start gap-2.5 border-t border-border/60 px-4 py-2 text-xs first:border-t-0",
								),
							],
							[
								h.div(
									[h.Class("mt-px shrink-0")],
									[commitAvatar(h, commit.authorAvatarUrl, author)],
								),
								h.div(
									[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
									[
										h.a(
											[
												h.Href(pr?.url ?? commit.htmlUrl),
												h.Target("_blank"),
												h.Rel("noreferrer"),
												h.Class("truncate text-foreground hover:underline"),
												h.Title(subject),
											],
											[subject],
										),
										h.span(
											[
												h.Class(
													"flex items-center gap-1.5 text-2xs text-muted-foreground",
												),
											],
											[
												h.span(
													[h.Class("font-mono")],
													[shortReleaseLabel(commit.sha)],
												),
												h.span([h.Class("truncate")], [author]),
											],
										),
									],
								),
								h.span(
									[
										h.Class(
											"shrink-0 font-mono text-2xs tabular-nums text-muted-foreground/70",
										),
									],
									[
										formatRelativeTimeOrDate(
											new Date(commit.committedAt).toISOString(),
											clock.nowMs,
											clock.timeZone,
										),
									],
								),
							],
						)
					}),
					...(hidden > 0
						? [
								h.div(
									[
										h.Class(
											"border-t border-border/60 px-4 py-2 text-2xs text-muted-foreground/70",
										),
									],
									[String(hidden), " older ", pluralize(hidden, "commit"), " not shown"],
								),
							]
						: []),
				],
			),
		],
	)
}

// Issue severity tones and labels (as in page/errors/kit/severity.ts).
const SEVERITY = new Map([
	["critical", { tone: "bg-severity-fatal/12 text-severity-fatal", label: "Critical" }],
	["high", { tone: "bg-severity-error/12 text-severity-error", label: "High" }],
	["medium", { tone: "bg-severity-warn/12 text-severity-warn", label: "Medium" }],
	["low", { tone: "bg-severity-debug/12 text-severity-debug", label: "Low" }],
])

const severityBadge = <M>(h: HtmlBuilder<M>, severity: string | null): Html => {
	const known = severity === null ? undefined : SEVERITY.get(severity)
	return known === undefined
		? h.span([h.Class(cn("inline-flex h-5", "w-[60px] justify-center")), h.Title("Severity not set")])
		: badge(h, { variant: "outline", className: cn(known.tone, "w-[60px] justify-center") }, [
				known.label,
			])
}

const issueLine = <M>(
	h: HtmlBuilder<M>,
	issue: ErrorIssueDocument,
	clock: Clock,
	occurrences: number | undefined,
	isServiceShown: boolean,
): Html => {
	const title = issue.errorLabel || issue.exceptionType || issue.exceptionMessage || "Unknown error"
	return listRow(h, {
		density: "compact",
		className: "gap-2.5 rounded-sm px-2 text-sm",
		href: hrefOf(AppRoute.ErrorIssue({ issueId: issue.id, search: {} })),
		leading: isServiceShown
			? h.span(
					[h.Class("contents")],
					[
						severityBadge(h, issue.severity),
						h.span(
							[h.Class("ml-2.5 inline-flex"), h.Title(issue.serviceName)],
							[serviceDot(h, { serviceName: issue.serviceName })],
						),
					],
				)
			: severityBadge(h, issue.severity),
		title: truncatedText(h, { text: title, className: "font-normal" }),
		trailing: h.span(
			[h.Class("contents")],
			[
				h.span(
					[
						h.Class("font-mono text-xs tabular-nums text-muted-foreground"),
						h.Title("Occurrences on this version in the window"),
					],
					[formatNumber(occurrences ?? issue.occurrenceCount), "×"],
				),
				relativeTime(h, {
					value: issue.lastSeenAt,
					nowMs: clock.nowMs,
					timeZone: clock.timeZone,
					variant: "orDate",
					mono: true,
					tooltip: "title",
					className: "w-14 text-right text-xs text-muted-foreground/70",
				}),
			],
		),
	})
}

/** `IssueList`. */
export const issueList = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		title: string
		issues: ReadonlyArray<ErrorIssueDocument>
		empty: string
		tone?: "error" | "warn"
		isServiceShown: boolean
		clock: Clock
		/** Occurrences on this version, by fingerprint (the release service body). */
		counts?: ReadonlyMap<string, number>
	}>,
): Html =>
	sectionCard(
		h,
		{
			title: options.title,
			action: h.span(
				[
					h.Class(
						options.issues.length === 0
							? "text-2xs text-muted-foreground/70"
							: options.tone === "error"
								? "text-2xs font-medium text-severity-error"
								: options.tone === "warn"
									? "text-2xs font-medium text-severity-warn"
									: "text-2xs text-muted-foreground",
					),
				],
				[String(options.issues.length)],
			),
		},
		[
			options.issues.length === 0
				? emptyMessage(h, {}, [options.empty])
				: h.div(
						[h.Class("space-y-px p-2")],
						options.issues.map((issue) =>
							issueLine(
								h,
								issue,
								options.clock,
								options.counts?.get(issue.fingerprintHash),
								options.isServiceShown,
							),
						),
					),
		],
	)
