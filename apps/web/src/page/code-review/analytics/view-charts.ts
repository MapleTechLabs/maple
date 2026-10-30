import type { CodeReviewAnalytics } from "@maple/domain/http"
import { bucketIso } from "../../../components/code-review/code-review-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as BarChart from "../../../charts/bar-chart"
import type * as Chart from "../../../charts/chart"
import type { ThemeColors } from "../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../route"
import type * as Select from "../../../ui/select"
import { type SelectEntry, view as selectView } from "../../../ui/select-view"
import { icon } from "../../../ui/icon"
import { analyticsPanel, chartFrame } from "../kit/analytics-panel"
import { Message } from "./message"
import type { Model } from "./model"
import { repositoryList } from "./view-lists"

// `VolumeCard` and `IssuesCard`.

type H = HtmlBuilder<Message>

const VOLUME_LABELS = { pullRequests: "PRs reviewed", reviews: "Reviews" } as const
const SEVERITY_LABELS = {
	all: "All severities",
	critical: "Critical",
	warn: "Warning",
	info: "Note",
} as const
/** Series names the shared palette colours by severity. */
export const SEVERITY_SERIES = { critical: "Critical", warn: "Warning", info: "Note" } as const

const entries = (labels: Readonly<Record<string, string>>): ReadonlyArray<SelectEntry> =>
	Object.entries(labels).map(([value, label]) => ({ _tag: "Item", item: { value, label } }))

const panelSelect = (
	h: H,
	model: Select.Model,
	labels: Readonly<Record<string, string>>,
	ariaLabel: string,
	wrap: (message: Select.Message) => Message,
): Html =>
	h.submodel({
		slotId: model.id,
		model,
		view: selectView,
		toParentMessage: wrap,
		viewInputs: {
			entries: entries(labels),
			size: "sm",
			ariaLabel,
			className: "w-36",
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
	})

type Rows = ReadonlyArray<Readonly<Record<string, string | number>>>

const barChart = (
	h: H,
	chart: "volume" | "issues",
	state: Chart.Model,
	data: Rows,
	theme: ThemeColors,
	nowMs: number,
	stacked: boolean,
	timeZone: string,
): Html =>
	h.submodel({
		slotId: `code-review-${chart}-chart`,
		model: state,
		view: BarChart.view,
		toParentMessage: (message: Chart.Message) => Message.GotChartMessage({ chart, message }),
		viewInputs: {
			chartId: `code-review-${chart}`,
			data,
			theme,
			nowMs,
			stacked,
			timeZone,
			className: "h-full w-full",
		},
	})

const isVolumeMetric = (value: string): value is keyof typeof VOLUME_LABELS => value in VOLUME_LABELS
const isSeverity = (value: string): value is keyof typeof SEVERITY_SERIES => value in SEVERITY_SERIES

const topRepositories = (analytics: CodeReviewAnalytics, by: "reviews" | "findings") =>
	analytics.repositories
		.filter((repo) => repo[by] > 0)
		.toSorted((a, b) => b[by] - a[by])
		.slice(0, 5)
		.map((repo) => ({ key: repo.repositoryId, name: repo.fullName, value: repo[by] }))

export const volumeCard = (
	h: H,
	model: Model,
	analytics: CodeReviewAnalytics,
	theme: ThemeColors,
	timeZone: string,
): Html => {
	const metric = isVolumeMetric(model.volumeSelect.value) ? model.volumeSelect.value : "pullRequests"
	const label = VOLUME_LABELS[metric]
	const rows = analytics.series.map((point) => ({
		bucket: bucketIso(point.bucket),
		[label]: point[metric],
	}))
	return analyticsPanel(
		h,
		{
			title: "Pull requests reviewed",
			control: panelSelect(h, model.volumeSelect, VOLUME_LABELS, "Volume metric", (message) =>
				Message.GotVolumeSelectMessage({ message }),
			),
			footer: repositoryList(h, "Top repositories by reviews", topRepositories(analytics, "reviews")),
		},
		[
			chartFrame(h, analytics.current.reviews === 0, () =>
				barChart(h, "volume", model.volumeChart, rows, theme, model.frame.nowMs, false, timeZone),
			),
		],
	)
}

const severityRows = (analytics: CodeReviewAnalytics, severity: string) =>
	analytics.series.map((point) =>
		isSeverity(severity)
			? { bucket: bucketIso(point.bucket), [SEVERITY_SERIES[severity]]: point[severity] }
			: {
					bucket: bucketIso(point.bucket),
					[SEVERITY_SERIES.critical]: point.critical,
					[SEVERITY_SERIES.warn]: point.warn,
					[SEVERITY_SERIES.info]: point.info,
				},
	)

export const issuesCard = (
	h: H,
	model: Model,
	analytics: CodeReviewAnalytics,
	theme: ThemeColors,
	timeZone: string,
): Html => {
	const { search } = model
	const href = hrefOf(
		AppRoute.CodeReviewIssues({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
				repo: search.repo,
				author: search.author,
			},
		}),
	)
	const footer = h.div(
		[h.Class("flex flex-col gap-3")],
		[
			repositoryList(h, "Repositories with the most issues", topRepositories(analytics, "findings")),
			h.a(
				[
					h.Class(
						"inline-flex items-center gap-1 self-center text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline",
					),
					h.Href(href),
				],
				["See all issues caught", icon(h, "ArrowRightIcon", { size: 14 })],
			),
		],
	)
	return analyticsPanel(
		h,
		{
			title: "Issues caught",
			control: panelSelect(h, model.severitySelect, SEVERITY_LABELS, "Severity", (message) =>
				Message.GotSeveritySelectMessage({ message }),
			),
			footer,
		},
		[
			chartFrame(h, analytics.current.findings === 0, () =>
				barChart(
					h,
					"issues",
					model.issuesChart,
					severityRows(analytics, model.severitySelect.value),
					theme,
					model.frame.nowMs,
					true,
					timeZone,
				),
			),
		],
	)
}
