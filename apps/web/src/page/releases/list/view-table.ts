import type { VcsCommitDetailResponse, VcsCommitRangeResponse } from "@maple/domain/http"
import { EMPTY_VALUE, formatErrorRate, formatLatency } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import {
	releaseDayLabel,
	releaseHeadline,
	shortReleaseLabel,
	type ReleaseGroup,
	type ReleaseIssueCounts,
	type ReleaseServiceImpact,
} from "../../../components/releases/release-model"
import { tableCellStyles } from "@maple/ui/styles/ui/table"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { panel } from "../../../ui/panel"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { serviceDot } from "../../../ui/values"
import { relativeTime } from "../../kit/relative-time"
import { commitAvatar, isResolvableSha, firstLine, releaseHealthFigure, releaseHref } from "../kit"
import { commitTrigger, type Overlays, releaseHealthPill } from "../overlays-view"
import { MountReleasesTable } from "./command"
import { Message } from "./message"
import type { TimeSearch } from "./view-overview"

// The releases table and its commit count.

type H = HtmlBuilder<Message>

/** "0.30% → 1.24%": the version it replaced, then this one. */
const baselineShift = (h: H, value: number, baseline: number | undefined, format: (value: number) => string, tone?: "error" | "warn"): Html =>
	h.span(
		[h.Class("inline-flex items-baseline gap-1 font-mono text-xs tabular-nums")],
		[
			...(baseline === undefined
				? []
				: [h.span([h.Class("text-3xs text-foreground-subtle"), h.Title("The version this one replaced")], [format(baseline), " →"])]),
			h.span([h.Class(cn(tone === "error" && "text-severity-error", tone === "warn" && "text-severity-warn"))], [format(value)]),
		],
	)

const issueCounts = (h: H, counts: ReleaseIssueCounts | undefined | null): Html | null => {
	if (counts === null) return null
	if (counts === undefined || (counts.fresh === 0 && counts.regressed === 0))
		return h.span([h.Class("font-mono text-xs text-foreground-faint")], [EMPTY_VALUE])
	return h.span(
		[h.Class("inline-flex items-baseline gap-2 whitespace-nowrap font-mono text-xs tabular-nums")],
		[
			...(counts.fresh > 0 ? [h.span([h.Class("text-severity-error")], [String(counts.fresh), " new"])] : []),
			...(counts.regressed > 0 ? [h.span([h.Class("text-severity-warn")], [String(counts.regressed), " regressed"])] : []),
		],
	)
}

const NAMED_SERVICES = 3

const serviceChip = (h: H, serviceName: string, className: string): Html =>
	h.span(
		[h.Key(serviceName), h.Class(className), h.Title(serviceName)],
		[serviceDot(h, { serviceName }), h.span([h.Class("truncate")], [serviceName])],
	)

const serviceChips = (h: H, services: ReadonlyArray<ReleaseServiceImpact>): Html => {
	const names = [...new Set(services.map((service) => service.serviceName))]
	if (names.length > NAMED_SERVICES) {
		const flagged = [...new Set(services.filter((service) => service.health !== "healthy").map((service) => service.serviceName))]
		return h.span(
			[h.Class("flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground")],
			[
				h.span([h.Class("tabular-nums")], [String(names.length), " services"]),
				...flagged.slice(0, 2).map((name) => serviceChip(h, name, "inline-flex min-w-0 max-w-56 items-center gap-1")),
				...(flagged.length > 2 ? [h.span([h.Class("text-2xs text-foreground-subtle")], [`+${flagged.length - 2}`])] : []),
			],
		)
	}
	return h.span(
		[h.Class("flex flex-wrap items-center gap-x-2 gap-y-0.5")],
		names.map((name) => serviceChip(h, name, "inline-flex min-w-0 max-w-56 items-center gap-1 text-xs text-muted-foreground")),
	)
}

/** `CommitCount`: "12 commits", only when a deploy carried more than its head commit. */
export const commitCount = (h: H, range: VcsCommitRangeResponse | undefined): Html | null =>
	range === undefined || range.totalCount < 2
		? null
		: h.span(
				[h.Class("tabular-nums"), h.Title(`Commits since ${shortReleaseLabel(range.base)}`)],
				[String(range.totalCount), range.truncated ? "+" : "", " commits"],
			)

const releaseTitle = (
	h: H,
	group: ReleaseGroup,
	commit: VcsCommitDetailResponse | undefined,
	figure: string | undefined,
	range: VcsCommitRangeResponse | undefined,
	overlays: Overlays<Message>,
): Html => {
	const author = commit?.authorLogin ?? commit?.authorName ?? undefined
	const count = commitCount(h, range)
	return h.div(
		[h.Class("flex min-w-0 items-start gap-2.5")],
		[
			h.div(
				[h.Class("mt-0.5 shrink-0")],
				[commit ? commitAvatar(h, commit.authorAvatarUrl, author ?? "Unknown author") : h.span([h.Class("block size-5 rounded-full bg-muted")])],
			),
			h.div(
				[h.Class("flex min-w-0 flex-col gap-0.5 leading-tight")],
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							commitTrigger(h, overlays, "releases-list", group.commitSha, cn("min-w-0 truncate text-sm text-foreground", commit === undefined && "font-mono text-xs"), [
								(commit ? firstLine(commit.message) : "") || shortReleaseLabel(group.commitSha),
							]),
							...(group.health === "healthy"
								? []
								: [releaseHealthPill(h, overlays, pillId(group.commitSha), group.health, figure)]),
						],
					),
					h.div(
						[h.Class("flex items-center gap-1.5 text-2xs text-muted-foreground")],
						[
							...(commit ? [h.span([h.Class("font-mono")], [shortReleaseLabel(group.commitSha)])] : []),
							...(author ? [h.span([h.Class("truncate")], [author])] : []),
							...(!commit && !isResolvableSha(group.commitSha) ? [h.span([], ["deployment reference"])] : []),
							...(count === null ? [] : [count]),
						],
					),
				],
			),
		],
	)
}

export type TableInput = Readonly<{
	groups: ReadonlyArray<ReleaseGroup>
	issueCounts: ReadonlyMap<string, ReleaseIssueCounts> | undefined
	timeSearch: TimeSearch
	environments: ReadonlyArray<string> | undefined
	isWaiting: boolean
	commits: ReadonlyMap<string, VcsCommitDetailResponse>
	ranges: ReadonlyMap<string, VcsCommitRangeResponse>
	expanded: ReadonlyArray<string>
	nowMs: number
	timeZone: string
	overlays: Overlays<Message>
}>

/** A DOM-safe id for one health pill's tooltip trigger. */
const pillId = (...parts: ReadonlyArray<string>): string =>
	`releases-pill-${parts.join("-").replace(/[^A-Za-z0-9_-]/g, "_")}`

const HEADERS: ReadonlyArray<readonly [string, string | undefined]> = [
	["Release", "w-[46%] min-w-64"],
	["Services", undefined],
	["Deployed", "whitespace-nowrap"],
	["Error rate", "whitespace-nowrap"],
	["p95", undefined],
	["Issues", undefined],
]

export const releasesTable = (h: H, input: TableInput): Html => {
	const linkSearch = (service: string, environment: string) => ({
		service,
		environments: input.environments ?? (environment ? [environment] : undefined),
		...input.timeSearch,
	})
	const href = (commitSha: string, service: string, environment: string) =>
		releaseHref(commitSha, linkSearch(service, environment))
	const time = (value: string) =>
		relativeTime(h, { value, nowMs: input.nowMs, timeZone: input.timeZone, variant: "orDate", tooltip: "title" })
	const rows = input.groups.flatMap((group, index): ReadonlyArray<Html> => {
		const day = releaseDayLabel(group.firstSeen, input.nowMs, input.timeZone)
		const previous = input.groups[index - 1]
		const showDay = previous === undefined || releaseDayLabel(previous.firstSeen, input.nowMs, input.timeZone) !== day
		const isOpen = input.expanded.includes(group.commitSha)
		const worst = releaseHeadline(group)
		const multi = group.services.length > 1
		const counts = input.issueCounts === undefined ? null : input.issueCounts.get(group.commitSha)
		return [
			...(showDay
				? [
						tableRow(h, [
							h.td(
								[
									h.Attribute("class", cn(tableCellStyles, cn(eyebrowVariants({}), "bg-surface-sunken py-1"))),
									h.Attribute("colspan", "6"),
									h.DataAttribute("slot", "eyebrow"),
								],
								[day],
							),
						], "hover:bg-transparent active:bg-transparent", [h.Key(`day:${group.commitSha}`)]),
					]
				: []),
			tableRow(
				h,
				[
					tableCell(
						h,
						[
							h.div(
								[h.Class("flex items-start gap-1")],
								[
									iconButton(
										h,
										{
											size: "icon-2xs",
											label: isOpen ? "Hide services" : "Show services",
											hasTooltip: false,
											className: cn(
												"mt-1 text-foreground-subtle transition-transform hover:text-foreground active:text-foreground",
												isOpen && "rotate-90",
												group.services.length <= 1 && "invisible",
											),
											attributes: [h.AriaExpanded(isOpen), h.OnClick(Message.ToggledExpanded({ commitSha: group.commitSha }))],
										},
										[icon(h, "ChevronRightIcon")],
									),
									h.a(
										[
											h.Href(href(group.commitSha, worst.serviceName, worst.environment)),
											h.Class("min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"),
										],
										[
											releaseTitle(
												h,
												group,
												input.commits.get(group.commitSha),
												releaseHealthFigure(worst),
												input.ranges.get(group.commitSha),
												input.overlays,
											),
										],
									),
								],
							),
						],
						"max-w-0 py-2",
					),
					tableCell(h, [serviceChips(h, group.services)], "whitespace-normal py-2 align-top"),
					tableCell(h, [time(group.firstSeen)], "whitespace-nowrap py-2 align-top font-mono text-xs tabular-nums text-muted-foreground"),
					tableCell(
						h,
						[
							h.span(
								[h.Class("inline-flex items-center gap-1.5")],
								[
									...(multi
										? [h.span([h.Class("inline-flex"), h.Title(`Worst service: ${worst.serviceName}`)], [serviceDot(h, { serviceName: worst.serviceName })])]
										: []),
									baselineShift(h, worst.errorRate, worst.baseline?.errorRate, formatErrorRate, worst.health === "regressed" ? "error" : undefined),
								],
							),
						],
						"py-2 align-top",
					),
					tableCell(
						h,
						[baselineShift(h, worst.p95LatencyMs, worst.baseline?.p95LatencyMs, formatLatency, worst.health === "watch" ? "warn" : undefined)],
						"py-2 align-top",
					),
					tableCell(h, [issueCounts(h, counts)].filter((node): node is Html => node !== null), "py-2 align-top"),
				],
				"group/row",
				[h.Key(group.commitSha)],
			),
			...(isOpen
				? group.services.map((service) =>
						tableRow(
							h,
							[
								tableCell(
									h,
									[
										h.a(
											[
												h.Href(href(group.commitSha, service.serviceName, service.environment)),
												h.Class("inline-flex max-w-full items-center gap-2 text-xs hover:underline active:underline"),
											],
											[
												serviceDot(h, { serviceName: service.serviceName }),
												h.span([h.Class("min-w-0 truncate"), h.Title(service.serviceName)], [service.serviceName]),
												...(service.environment && !input.environments?.length
													? [h.span([h.Class("min-w-0 truncate text-foreground-subtle")], [service.environment])]
													: []),
												...(service.health === "healthy"
													? []
													: [
															releaseHealthPill(
																h,
																input.overlays,
																pillId(group.commitSha, service.serviceName, service.environment),
																service.health,
																releaseHealthFigure(service),
																"shrink-0",
															),
														]),
											],
										),
									],
									"max-w-0 py-1.5 pl-12",
								),
								tableCell(h, [], "py-1.5"),
								tableCell(h, [time(service.firstSeen)], "whitespace-nowrap py-1.5 font-mono text-xs tabular-nums text-muted-foreground"),
								tableCell(
									h,
									[baselineShift(h, service.errorRate, service.baseline?.errorRate, formatErrorRate, service.health === "regressed" ? "error" : undefined)],
									"py-1.5",
								),
								tableCell(
									h,
									[baselineShift(h, service.p95LatencyMs, service.baseline?.p95LatencyMs, formatLatency, service.health === "watch" ? "warn" : undefined)],
									"py-1.5",
								),
								tableCell(h, [], "py-1.5"),
							],
							"bg-surface-faint",
							[h.Key(`${group.commitSha}:${service.serviceName}:${service.environment}`)],
						),
					)
				: []),
		]
	})
	return panel(h, { className: refreshingClass(input.isWaiting) }, [
		h.div(
			[h.Class("contents"), h.OnMount(MountReleasesTable()), ...(input.isWaiting ? [h.AriaBusy(true)] : [])],
			[
				table(h, {}, [
					tableHeader(h, [tableRow(h, HEADERS.map(([label, className]) => tableHead(h, [label], className)))]),
					tableBody(h, rows),
				]),
			],
		),
	])
}

