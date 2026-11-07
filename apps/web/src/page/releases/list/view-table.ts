import type { VcsCommitDetailResponse, VcsCommitRangeResponse } from "@maple/domain/http"
import { formatErrorRate, formatLatency } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import {
	releaseDayLabel,
	releaseHeadline,
	shortReleaseLabel,
	type ReleaseGroup,
	type ReleaseIssueCounts,
	type ReleaseServiceImpact,
} from "../../../components/releases/release-model"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { panel } from "@maple/views/ui/panel"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { emptyValue, errorRateValue, latencyValue, serviceDot } from "@maple/views/ui/values"
import { relativeTime } from "../../kit/relative-time"
import { commitAvatar, isResolvableSha, firstLine, releaseHealthFigure, releaseHref } from "../kit"
import { commitTrigger, type Overlays, releaseHealthPill } from "../overlays-view"
import { MountReleasesTable } from "./command"
import { Message } from "./message"
import type { TimeSearch } from "./view-overview"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str } from "effect"

// The releases table and its commit count.

type H = HtmlBuilder<Message>

/** "0.30% → 1.24%": the version it replaced, then this one. */
const baselineShift = (h: H, baseline: string | undefined, current: Html): Html =>
	hstack(
		h,
		{
			gap: "1",
			align: "baseline",
			inline: true,
			as: "span",
			className: "font-mono text-xs tabular-nums",
		},
		[
			...(baseline === undefined
				? []
				: [
						typography(
							h,
							{
								size: "3xs",
								tone: "subtle",
								attributes: [h.Title("The version this one replaced")],
							},
							[baseline, " →"],
						),
					]),
			current,
		],
	)

/** The current value in its threshold tone, unless the release's health calls it out. */
const healthTone = (tone: "error" | "warn" | undefined): string | undefined =>
	tone === "error" ? "text-severity-error" : tone === "warn" ? "text-severity-warn" : undefined

const errorRateShift = (h: H, value: number, baseline: number | undefined, tone?: "error"): Html =>
	baselineShift(
		h,
		baseline === undefined ? undefined : formatErrorRate(baseline),
		errorRateValue(h, { rate: value, className: healthTone(tone) }),
	)

const latencyShift = (h: H, value: number, baseline: number | undefined, tone?: "warn"): Html =>
	baselineShift(
		h,
		baseline === undefined ? undefined : formatLatency(baseline),
		latencyValue(h, { ms: value, className: healthTone(tone) }),
	)

const issueCounts = (h: H, counts: ReleaseIssueCounts | undefined | null): Html | null => {
	if (counts === null) return null
	if (counts === undefined || (counts.fresh === 0 && counts.regressed === 0))
		return emptyValue(h, typographyClass({ size: "xs", mono: true }))
	return hstack(
		h,
		{
			gap: "2",
			align: "baseline",
			inline: true,
			as: "span",
			className: "whitespace-nowrap font-mono text-xs tabular-nums",
		},
		[
			...(counts.fresh > 0 ? [typography(h, { tone: "error" }, [String(counts.fresh), " new"])] : []),
			...(counts.regressed > 0
				? [typography(h, { tone: "warning" }, [String(counts.regressed), " regressed"])]
				: []),
		],
	)
}

const NAMED_SERVICES = 3

const serviceChip = (h: H, serviceName: string, className: string): Html =>
	h.span(
		[h.Key(serviceName), h.Class(className), h.Title(serviceName)],
		[serviceDot(h, { serviceName }), typography(h, { truncate: true }, [serviceName])],
	)

const serviceChips = (h: H, services: ReadonlyArray<ReleaseServiceImpact>): Html => {
	const names = [...new Set(Arr.map(services, (service) => service.serviceName))]
	if (names.length > NAMED_SERVICES) {
		const flagged = [
			...new Set(
				Arr.map(
					Arr.filter(services, (service) => service.health !== "healthy"),
					(service) => service.serviceName,
				),
			),
		]
		return hstack(
			h,
			{
				align: "center",
				wrap: true,
				as: "span",
				className: "gap-x-2 gap-y-0.5 text-xs text-muted-foreground",
			},
			[
				typography(h, { numeric: true }, [String(names.length), " services"]),
				...Arr.map(flagged.slice(0, 2), (name) =>
					serviceChip(h, name, "inline-flex min-w-0 max-w-56 items-center gap-1"),
				),
				...(flagged.length > 2
					? [typography(h, { size: "2xs", tone: "subtle" }, [`+${flagged.length - 2}`])]
					: []),
			],
		)
	}
	return hstack(
		h,
		{ align: "center", wrap: true, as: "span", className: "gap-x-2 gap-y-0.5" },
		Arr.map(names, (name) =>
			serviceChip(
				h,
				name,
				"inline-flex min-w-0 max-w-56 items-center gap-1 text-xs text-muted-foreground",
			),
		),
	)
}

/** `CommitCount`: "12 commits", only when a deploy carried more than its head commit. */
export const commitCount = (h: H, range: VcsCommitRangeResponse | undefined): Html | null =>
	range === undefined || range.totalCount < 2
		? null
		: typography(
				h,
				{ numeric: true, attributes: [h.Title(`Commits since ${shortReleaseLabel(range.base)}`)] },
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
	return hstack(h, { gap: "2.5", align: "start", shrink: true }, [
		h.div(
			[h.Class("mt-0.5 shrink-0")],
			[
				commit
					? commitAvatar(h, commit.authorAvatarUrl, author ?? "Unknown author")
					: h.span([h.Class("block size-5 rounded-full bg-muted")]),
			],
		),
		vstack(h, { gap: "0.5", shrink: true, className: "leading-tight" }, [
			hstack(h, { gap: "2", shrink: true }, [
				commitTrigger(
					h,
					overlays,
					"releases-list",
					group.commitSha,
					cn(
						"min-w-0 truncate text-sm text-foreground",
						commit === undefined && typographyClass({ size: "xs", mono: true }),
					),
					[(commit ? firstLine(commit.message) : "") || shortReleaseLabel(group.commitSha)],
				),
				...(group.health === "healthy"
					? []
					: [releaseHealthPill(h, overlays, pillId(group.commitSha), group.health, figure)]),
			]),
			hstack(h, { gap: "1.5", align: "center", className: "text-2xs text-muted-foreground" }, [
				...(commit ? [typography(h, { mono: true }, [shortReleaseLabel(group.commitSha)])] : []),
				...(author ? [typography(h, { truncate: true }, [author])] : []),
				...(!commit && !isResolvableSha(group.commitSha)
					? [h.span([], ["deployment reference"])]
					: []),
				...(count === null ? [] : [count]),
			]),
		]),
	])
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
	`releases-pill-${Str.replace(/[^A-Za-z0-9_-]/g, "_")(Arr.join(parts, "-"))}`

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
		relativeTime(h, {
			value,
			nowMs: input.nowMs,
			timeZone: input.timeZone,
			variant: "orDate",
		})
	const rows = Arr.flatMap(input.groups, (group, index): ReadonlyArray<Html> => {
		const day = releaseDayLabel(group.firstSeen, input.nowMs, input.timeZone)
		const previous = input.groups[index - 1]
		const showDay =
			previous === undefined || releaseDayLabel(previous.firstSeen, input.nowMs, input.timeZone) !== day
		const isOpen = input.expanded.includes(group.commitSha)
		const worst = releaseHeadline(group)
		const multi = group.services.length > 1
		const counts = input.issueCounts === undefined ? null : input.issueCounts.get(group.commitSha)
		return [
			...(showDay
				? [
						tableRow(
							h,
							[
								tableCell(h, [eyebrow(h, {}, [day])], "bg-surface-sunken py-1", [
									h.Attribute("colspan", "6"),
								]),
							],
							"hover:bg-transparent active:bg-transparent",
							[h.Key(`day:${group.commitSha}`)],
						),
					]
				: []),
			tableRow(
				h,
				[
					tableCell(
						h,
						[
							hstack(h, { gap: "1", align: "start" }, [
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
										attributes: [
											h.AriaExpanded(isOpen),
											h.OnClick(
												Message.ToggledExpanded({ commitSha: group.commitSha }),
											),
										],
									},
									[icon(h, "ChevronRightIcon")],
								),
								h.a(
									[
										h.Href(href(group.commitSha, worst.serviceName, worst.environment)),
										h.Class(
											"min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
										),
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
							]),
						],
						"max-w-0 py-2",
					),
					tableCell(h, [serviceChips(h, group.services)], "whitespace-normal py-2 align-top"),
					tableCell(
						h,
						[time(group.firstSeen)],
						"whitespace-nowrap py-2 align-top font-mono text-xs tabular-nums text-muted-foreground",
					),
					tableCell(
						h,
						[
							hstack(h, { gap: "1.5", inline: true, as: "span" }, [
								...(multi
									? [
											hstack(
												h,
												{
													align: "stretch",
													inline: true,
													as: "span",
													attributes: [
														h.Title(`Worst service: ${worst.serviceName}`),
													],
												},
												[serviceDot(h, { serviceName: worst.serviceName })],
											),
										]
									: []),
								errorRateShift(
									h,
									worst.errorRate,
									worst.baseline?.errorRate,
									worst.health === "regressed" ? "error" : undefined,
								),
							]),
						],
						"py-2 align-top",
					),
					tableCell(
						h,
						[
							latencyShift(
								h,
								worst.p95LatencyMs,
								worst.baseline?.p95LatencyMs,
								worst.health === "watch" ? "warn" : undefined,
							),
						],
						"py-2 align-top",
					),
					tableCell(
						h,
						Arr.filter([issueCounts(h, counts)], (node): node is Html => node !== null),
						"py-2 align-top",
					),
				],
				"group/row",
				[h.Key(group.commitSha)],
			),
			...(isOpen
				? Arr.map(group.services, (service) =>
						tableRow(
							h,
							[
								tableCell(
									h,
									[
										h.a(
											[
												h.Href(
													href(
														group.commitSha,
														service.serviceName,
														service.environment,
													),
												),
												h.Class(
													"inline-flex max-w-full items-center gap-2 text-xs hover:underline active:underline",
												),
											],
											[
												serviceDot(h, { serviceName: service.serviceName }),
												typography(
													h,
													{
														truncate: true,
														className: "min-w-0",
														attributes: [h.Title(service.serviceName)],
													},
													[service.serviceName],
												),
												...(service.environment &&
												(input.environments === undefined ||
													input.environments.length === 0)
													? [
															typography(
																h,
																{
																	tone: "subtle",
																	truncate: true,
																	className: "min-w-0",
																},
																[service.environment],
															),
														]
													: []),
												...(service.health === "healthy"
													? []
													: [
															releaseHealthPill(
																h,
																input.overlays,
																pillId(
																	group.commitSha,
																	service.serviceName,
																	service.environment,
																),
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
								tableCell(
									h,
									[time(service.firstSeen)],
									"whitespace-nowrap py-1.5 font-mono text-xs tabular-nums text-muted-foreground",
								),
								tableCell(
									h,
									[
										errorRateShift(
											h,
											service.errorRate,
											service.baseline?.errorRate,
											service.health === "regressed" ? "error" : undefined,
										),
									],
									"py-1.5",
								),
								tableCell(
									h,
									[
										latencyShift(
											h,
											service.p95LatencyMs,
											service.baseline?.p95LatencyMs,
											service.health === "watch" ? "warn" : undefined,
										),
									],
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
			[
				h.Class("contents"),
				h.OnMount(MountReleasesTable()),
				...(input.isWaiting ? [h.AriaBusy(true)] : []),
			],
			[
				table(h, {}, [
					tableHeader(h, [
						tableRow(
							h,
							Arr.map(HEADERS, ([label, className]) => tableHead(h, [label], className)),
						),
					]),
					tableBody(h, rows),
				]),
			],
		),
	])
}
