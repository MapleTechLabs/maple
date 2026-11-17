import {
	CLOUD_FINDING_SEVERITIES,
	CLOUD_FINDING_SOURCES,
	type CloudFindingSeverity,
	CloudFindingStatus,
} from "@maple/domain/cloud-security"
import type { CloudFinding } from "@maple/domain/http"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import type { Tone } from "@maple/ui/lib/tone"
import * as Keyed from "@maple/views/data/keyed"
import { Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { compactSearchInput } from "@maple/views/ui/compact-search-input"
import { errorState } from "@maple/views/ui/error-state"
import { listFooter } from "@maple/views/ui/list-footer"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { panel } from "@maple/views/ui/panel"
import { filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { vstack } from "@maple/views/ui/stack"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { textLink } from "@maple/views/ui/text-link"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { typography, typographyClass } from "@maple/views/ui/typography"
import type { BreadcrumbEntry } from "../../../shell"
import type { PageViewInputs } from "../../contract"
import { relativeTime } from "../../kit/relative-time"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { breadcrumbsOf as securityCrumbs, ROOMY_COLUMN, securityLayout, WIDE_COLUMN } from "../kit/layout"
import { placeholderRows } from "../kit/parts"
import {
	accountsOf,
	affectedSummary,
	findingHref,
	findingsOf,
	isFiltered,
	isTelemetryMatched,
	listHref,
	nextOffsetOf,
	overviewOf,
	regionsOf,
	resourceLabel,
	SEVERITY_LABEL,
	serviceNoticesOf,
	setupOf,
	sourceTitle,
	STATUS_LABEL,
	deliveryOf,
} from "./derive"
import { Message, type Model, type Overview, type SelectFilter } from "./model"
import { cloudSeverityBadge } from "./parts"
import { detailBody } from "./view-detail"
import { allClear, awaitingFirstRead, serviceNotices, setupState } from "./view-setup"
import { panelToolbar } from "../../kit/panel-toolbar"

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const SEVERITY_TONE = {
	critical: "crit",
	high: "crit",
	medium: "warn",
	low: "neutral",
	info: "neutral",
} as const satisfies Record<CloudFindingSeverity, Tone>

/** `Security › Cloud`, then the finding's title on its detail. */
export const breadcrumbsOf = (model: Model): ReadonlyArray<BreadcrumbEntry> => {
	if (model.screen === "list") return securityCrumbs("cloud")
	const [security] = securityCrumbs("cloud")
	const title = AsyncData.matchData(model.detail.data, {
		onEmpty: () => "Finding",
		onFailure: () => "Finding",
		onData: (detail) => detail.finding.title,
	})
	return [
		...(security === undefined ? [] : [security]),
		{ label: "Cloud", href: listHref() },
		{ label: title },
	]
}

const filterSelect = (
	h: H,
	filter: SelectFilter,
	name: string,
	value: string | undefined,
	all: string,
	options: ReadonlyArray<readonly [string, string]>,
): Html =>
	nativeSelect(
		h,
		{
			size: "sm",
			value: value ?? "",
			attributes: [
				h.AriaLabel(name),
				h.OnChange((next) => Message.ChangedFilter({ filter, value: next })),
			],
		},
		[
			...(all === "" ? [] : [nativeOption("", all)]),
			...Arr.map(options, ([option, label]) => nativeOption(option, label)),
		],
	)

const toolbar = (h: H, model: Model, overview: Overview): Html =>
	panelToolbar(h, [
		filterSelect(
			h,
			"status",
			"Status",
			model.search.status ?? "active",
			"",
			Arr.map(CloudFindingStatus.literals, (status) => [status, STATUS_LABEL[status]] as const),
		),
		filterSelect(
			h,
			"severity",
			"Severity",
			model.search.severity,
			"All severities",
			Arr.map(CLOUD_FINDING_SEVERITIES, (severity) => [severity, SEVERITY_LABEL[severity]] as const),
		),
		filterSelect(
			h,
			"source",
			"Source",
			model.search.source,
			"All sources",
			Arr.map(CLOUD_FINDING_SOURCES, (source) => [source, sourceTitle(source)] as const),
		),
		...(accountsOf(overview).length > 1
			? [
					filterSelect(
						h,
						"account",
						"Account",
						model.search.account,
						"All accounts",
						Arr.map(accountsOf(overview), (account) => [account, account] as const),
					),
				]
			: []),
		filterSelect(
			h,
			"region",
			"Region",
			model.search.region,
			"All regions",
			Arr.map(regionsOf(overview), (region) => [region, region] as const),
		),
		compactSearchInput(h, {
			value: model.searchText,
			placeholder: "Title, type or resource, then Enter",
			ariaLabel: "Search findings",
			onInput: (value) => Message.ChangedSearchText({ value }),
			onClear: Message.ClearedSearch(),
			onEnter: Message.SubmittedSearch(),
			className: "w-64",
		}),
		...(isFiltered(model.search)
			? [
					button(
						h,
						{
							variant: "ghost",
							size: "sm",
							attributes: [h.OnClick(Message.ClickedClearFilters())],
						},
						["Clear filters"],
					),
				]
			: []),
	])

/** Active findings by severity; a tile filters the list to its severity. */
const severityRail = (h: H, model: Model, overview: Overview): Html =>
	statRail(
		h,
		{ columns: 5, className: "grid-cols-2 md:grid-cols-5" },
		Arr.map(CLOUD_FINDING_SEVERITIES, (severity) => {
			const count = overview.summary.bySeverity[severity]
			const isSelected = model.search.severity === severity
			return statRailItem(h, {
				eyebrow: SEVERITY_LABEL[severity],
				value: String(count),
				tone: count > 0 ? SEVERITY_TONE[severity] : "neutral",
				compact: true,
				subline: "active",
				onSelect: Message.ChangedFilter({ filter: "severity", value: isSelected ? "" : severity }),
				isSelected,
				ariaLabel: `${count} active ${SEVERITY_LABEL[severity]} findings${isSelected ? ", filtered" : ""}`,
			})
		}),
	)

const affectedCell = (h: H, finding: CloudFinding, isMatched: boolean): Html => {
	const summary = affectedSummary(finding)
	return summary === null
		? typography(h, { size: "xs", tone: "muted" }, [isMatched ? "No telemetry" : "Not checked"])
		: truncatedText(h, { text: summary, tooltip: "overflow", className: typographyClass({ size: "xs" }) })
}

const findingRow = (h: H, finding: CloudFinding, clock: Clock, isMatched: boolean): Html => {
	const small = typographyClass({ size: "2xs", tone: "muted" })
	return tableRow(
		h,
		[
			tableCell(h, [cloudSeverityBadge(h, finding.severity)], "w-24"),
			tableCell(
				h,
				[
					vstack(h, { shrink: true }, [
						typography(h, { weight: "medium", truncate: true, as: "div" }, [
							textLink(
								h,
								{ href: findingHref(finding), tone: "inherit", className: "block truncate" },
								[finding.title],
							),
						]),
						truncatedText(h, {
							text: finding.type,
							mono: true,
							tooltip: "overflow",
							className: small,
						}),
						// A phone has no Resource or Affected column: both ride under the title.
						h.span(
							[h.Class("sm:hidden")],
							[
								truncatedText(h, {
									text: resourceLabel(finding),
									mono: true,
									className: small,
								}),
								affectedCell(h, finding, isMatched),
							],
						),
					]),
				],
				"max-w-44 sm:max-w-72",
			),
			tableCell(
				h,
				[
					truncatedText(h, {
						text: resourceLabel(finding),
						mono: true,
						tooltip: "overflow",
						className: typographyClass({ size: "xs" }),
					}),
				],
				`max-w-48 ${WIDE_COLUMN}`,
			),
			tableCell(h, [affectedCell(h, finding, isMatched)], `max-w-56 ${WIDE_COLUMN}`),
			tableCell(
				h,
				[
					vstack(h, {}, [
						typography(h, { size: "xs", mono: true }, [finding.region]),
						typography(h, { size: "2xs", tone: "muted", mono: true }, [finding.accountId]),
					]),
				],
				ROOMY_COLUMN,
			),
			tableCell(h, [typography(h, { size: "xs" }, [sourceTitle(finding.source)])], ROOMY_COLUMN),
			tableCell(
				h,
				[
					relativeTime(h, {
						value: finding.lastSeenAt,
						...clock,
						variant: "short",
						className: typographyClass({
							size: "xs",
							tone: "muted",
							className: "whitespace-nowrap",
						}),
					}),
				],
				WIDE_COLUMN,
			),
		],
		undefined,
		[h.Key(`${finding.connectionId}:${finding.region}:${finding.source}:${finding.findingId}`)],
	)
}

const findingsTable = (h: H, findings: ReadonlyArray<CloudFinding>, clock: Clock, isMatched: boolean): Html =>
	table(h, { ariaLabel: "Cloud findings" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Severity"], "w-24"),
				tableHead(h, ["Finding"]),
				tableHead(h, ["Resource"], WIDE_COLUMN),
				tableHead(h, ["Affected services"], WIDE_COLUMN),
				tableHead(h, ["Account / region"], ROOMY_COLUMN),
				tableHead(h, ["Source"], ROOMY_COLUMN),
				tableHead(h, ["Last seen"], WIDE_COLUMN),
			]),
		]),
		tableBody(
			h,
			Arr.map(findings, (finding) => findingRow(h, finding, clock, isMatched)),
		),
	])

const listBody = (h: H, model: Model, overview: Overview, clock: Clock): Html =>
	AsyncData.matchData(model.firstPage.data, {
		onEmpty: () => placeholderRows(h, 6),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load cloud findings",
				onRetry: Message.ClickedRetry(),
				className: "border-0",
			}),
		onData: () => {
			const findings = findingsOf(model) ?? []
			const isRefetching = Keyed.isInFlight(model.firstPage)
			if (findings.length === 0 && isRefetching) return placeholderRows(h, 6)
			// No service read yet: an empty list is neither an all clear nor a filter that matched nothing.
			if (findings.length === 0 && overview.services.length === 0) return awaitingFirstRead(h)
			if (findings.length === 0 && isFiltered(model.search))
				return filteredEmpty(h, {
					noun: "findings",
					description: "Try another severity, source or region, or another search.",
					onClear: Message.ClickedClearFilters(),
					className: "py-8",
				})
			if (findings.length === 0)
				return allClear(
					h,
					Arr.some(serviceNoticesOf(overview), (notice) => notice.state !== "not_enabled"),
				)
			const canExtend = Keyed.canExtend(model.firstPage)
			const footer = listFooter(h, {
				shown: findings.length,
				noun: "findings",
				hasMore: canExtend && nextOffsetOf(model) !== null,
				isLoading: model.laterPages.isFetching,
				isFailed: canExtend && model.laterPages.isFailed,
				onLoadMore: Message.ClickedLoadMore(),
				className: "border-t",
			})
			const isMatched = isTelemetryMatched(model)
			return vstack(
				h,
				{ className: refreshingClass(isRefetching), attributes: [h.AriaBusy(isRefetching)] },
				[
					findingsTable(h, findings, clock, isMatched),
					...(footer === null ? [] : [footer]),
					...(isMatched
						? []
						: [
								typography(
									h,
									{ size: "xs", tone: "muted", as: "p", className: "border-t px-4 py-2" },
									[
										"Telemetry could not be fully read just now, so affected services may be missing.",
									],
								),
							]),
				],
			)
		},
	})

const listScreen = (h: H, model: Model, overview: Overview, clock: Clock): ReadonlyArray<Html> => {
	const setup = setupOf(overview)
	if (setup !== "Ready") return [setupState(h, setup)]
	const notices = serviceNotices(h, serviceNoticesOf(overview))
	return [
		...(notices === null ? [] : [notices]),
		severityRail(h, model, overview),
		panel(h, { className: "overflow-hidden" }, [
			toolbar(h, model, overview),
			listBody(h, model, overview, clock),
		]),
		...deliveryNote(h, deliveryOf(overview, model.nowMs)),
	]
}

/** How findings reach Maple, under the list: live for the services whose events arrive, polled otherwise. */
const deliveryNote = (h: H, delivery: ReturnType<typeof deliveryOf>): ReadonlyArray<Html> => {
	if (delivery === null) return []
	const text =
		delivery.live.length === 0
			? "Checked every five minutes, and live once AWS sends a finding event. A connection set up before live updates needs its AWS setup script run again."
			: delivery.allLive
				? "Live: findings arrive as AWS reports them."
				: `Live for ${Arr.join(Arr.map(delivery.live, sourceTitle), ", ")}: their findings arrive as AWS reports them. The other enabled services are checked every five minutes.`
	return [typography(h, { size: "xs", tone: "muted", as: "p" }, [text])]
}

const overviewFailure = (h: H, model: Model): Html | null =>
	AsyncData.matchData(model.overview.data, {
		onEmpty: () => null,
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load cloud security",
				onRetry: Message.ClickedRetry(),
			}),
		onData: () => null,
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const clock = { nowMs: model.nowMs, timeZone: inputs.context.timeZone }
	const frame = (children: ReadonlyArray<Html>) =>
		securityLayout(h, { source: "cloud", hasCloud: true }, children)
	const failure = overviewFailure(h, model)
	if (failure !== null) return frame([failure])
	const overview = overviewOf(model)
	if (overview === null) return frame([placeholderRows(h, 6)])
	return frame(
		model.screen === "list" ? listScreen(h, model, overview, clock) : detailBody(h, model, clock),
	)
})
