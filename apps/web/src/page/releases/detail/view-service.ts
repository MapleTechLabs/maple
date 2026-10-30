import type { ErrorIssueDocument, VcsCommitRangeResponse } from "@maple/domain/http"
import { formatPercent } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import {
	NEW_ISSUE_SLACK_MS,
	shortReleaseLabel,
	type ReleaseServiceImpact,
} from "../../../components/releases/release-model"
import { errorIssueFromV2 } from "../../../lib/services/error-issues"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import { MountLinkedCursor } from "../../../charts/linked-cursor"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../route"
import { linkButton } from "../../../ui/button"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { panel } from "../../../ui/panel"
import { segmentedSelect } from "../../../ui/segmented-select"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { serviceDot } from "../../../ui/values"
import { relativeTime } from "../../kit/relative-time"
import { CHART_TOKENS, metricsGridOf } from "../../services/detail/view-charts"
import { commitRangesKey, isResolvableSha, releaseHealthFigure, withQueryOrder } from "../kit"
import { commitTrigger, type Overlays, releaseHealthPill } from "../overlays-view"
import { Message } from "./message"
import type { Model } from "./model"
import {
	baselineOf,
	derivedOf,
	FINGERPRINT_LIMIT,
	markersOf,
	seriesPoints,
	type ServiceDerived,
} from "./service"
import { releaseComparison, releaseVersionsRail } from "./view-comparison"
import { type ChangesetState, type Clock, issueList, releaseChangeset, sectionCard } from "./view-sections"

// The release body for one service (`?service=`) and its issues panel.

type H = HtmlBuilder<Message>

const timeSearchOf = (model: Model) => ({
	startTime: model.search.startTime,
	endTime: model.search.endTime,
	timePreset: model.search.timePreset,
})

/** `ReleaseChangeset`'s state for `base..head`, off the changeset slot. */
export const changesetState = (model: Model, base: string | undefined): ChangesetState => {
	if (base === undefined) return { _tag: "NoBase" }
	if (commitRangesKey([{ base, head: model.commitSha }]) === "") return { _tag: "NotShas" }
	const loadedState = (ranges: ReadonlyArray<VcsCommitRangeResponse>): ChangesetState => {
		const range = ranges[0]
		return range === undefined || range.status === "unavailable"
			? { _tag: "Unavailable", base }
			: { _tag: "Loaded", base, range }
	}
	return AsyncData.match(model.changeset.data, {
		onIdle: (): ChangesetState => ({ _tag: "Loading", base }),
		onLoading: (): ChangesetState => ({ _tag: "Loading", base }),
		onFailure: (): ChangesetState => ({ _tag: "Unavailable", base }),
		onStale: (): ChangesetState => ({ _tag: "Unavailable", base }),
		onSuccess: loadedState,
		onRefreshing: loadedState,
	})
}

/** The header's service button (`headerActions`): the service page over the same window. */
export const serviceButton = (h: H, model: Model, serviceName: string): Html =>
	linkButton(
		h,
		{
			variant: "outline",
			size: "sm",
			href: withQueryOrder(
				hrefOf(
					AppRoute.Service({
						serviceName,
						search: { ...timeSearchOf(model), environments: model.search.environments },
					}),
				),
				["startTime", "endTime", "timePreset", "environments"],
			),
		},
		[serviceDot(h, { serviceName }), serviceName],
	)

const bodySkeleton = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-3")],
		[
			skeleton(h, "h-4 w-80"),
			h.div(
				[h.Class("grid gap-3 lg:grid-cols-2")],
				[skeleton(h, "h-56 rounded-md"), skeleton(h, "h-56 rounded-md")],
			),
			skeleton(h, "h-72 rounded-md"),
		],
	)

/** The release pages' overlays as this page's view passes them on. */
export const overlaysOf = (model: Model, clock: Clock): Overlays<Message> => ({
	model: model.overlays,
	toParent: (message) => Message.GotOverlaysMessage({ message }),
	clock,
})

/** `ReleaseMeta`: author, repo and the provider link once the sha resolves. */
const releaseMeta = (h: H, model: Model, clock: Clock): ReadonlyArray<Html> => {
	if (!isResolvableSha(model.commitSha)) return [h.span([], ["deployment reference"])]
	return Option.match(AsyncData.getData(model.commit.data), {
		onNone: () => [
			commitTrigger(h, overlaysOf(model, clock), "release-meta", model.commitSha, "font-mono", [
				shortReleaseLabel(model.commitSha),
			]),
		],
		onSome: (commit) => [
			h.span([h.Class("truncate")], [commit.authorLogin ?? commit.authorName ?? "Unknown author"]),
			h.span([h.Class("truncate text-foreground-subtle")], [commit.repoFullName]),
			h.a(
				[
					h.Href(commit.htmlUrl),
					h.Target("_blank"),
					h.Rel("noreferrer"),
					h.Class("font-mono text-primary hover:underline"),
				],
				[shortReleaseLabel(model.commitSha), " ↗"],
			),
		],
	})
}

const metaLine = (
	h: H,
	model: Model,
	impact: ReleaseServiceImpact,
	serviceName: string,
	clock: Clock,
): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 text-xs text-muted-foreground")],
		[
			...releaseMeta(h, model, clock),
			h.span(
				[],
				[
					"first seen",
					" ",
					relativeTime(h, {
						value: impact.firstSeen,
						nowMs: clock.nowMs,
						timeZone: clock.timeZone,
						variant: "orDate",
						className: "text-foreground",
					}),
					" on",
					" ",
					serviceName,
				],
			),
			...(impact.environment ? [h.span([], [impact.environment])] : []),
			...(impact.share === undefined
				? []
				: [h.span([], [formatPercent(impact.share), " of the latest traffic"])]),
			...(impact.health === "healthy"
				? []
				: [releaseHealthPill(h, overlaysOf(model, clock), "release-meta-pill", impact.health, releaseHealthFigure(impact))]),
		],
	)

type Split = Readonly<{
	fresh: Array<ErrorIssueDocument>
	regressed: Array<ErrorIssueDocument>
	ongoing: Array<ErrorIssueDocument>
}>

/** `splitReleaseIssues`: new with this version, fixed and back, or already open. */
const splitIssues = (issues: ReadonlyArray<ErrorIssueDocument>, releaseFirstSeen: string): Split => {
	const cutoff = toEpochMs(releaseFirstSeen) - NEW_ISSUE_SLACK_MS
	const isFresh = (issue: ErrorIssueDocument) => toEpochMs(issue.firstSeenAt) >= cutoff
	const isRegressed = (issue: ErrorIssueDocument) =>
		!isFresh(issue) && issue.lastRegressedAt !== null && toEpochMs(issue.lastRegressedAt) >= cutoff
	return {
		fresh: issues.filter(isFresh),
		regressed: issues.filter(isRegressed),
		ongoing: issues.filter((issue) => !isFresh(issue) && !isRegressed(issue)),
	}
}

const PANEL_TITLES = ["New on this version", "Regressed on this version", "Still occurring"] as const

const issueLists = (
	h: H,
	split: Split,
	counts: ReadonlyMap<string, number>,
	empties: readonly [string, string, string],
	clock: Clock,
): Html =>
	h.div(
		[h.Class("grid gap-3 lg:grid-cols-3")],
		[
			issueList(h, {
				title: PANEL_TITLES[0],
				issues: split.fresh,
				counts,
				empty: empties[0],
				tone: "error",
				isServiceShown: false,
				clock,
			}),
			issueList(h, {
				title: PANEL_TITLES[1],
				issues: split.regressed,
				counts,
				empty: empties[1],
				tone: "warn",
				isServiceShown: false,
				clock,
			}),
			issueList(h, {
				title: PANEL_TITLES[2],
				issues: split.ongoing,
				counts,
				empty: empties[2],
				isServiceShown: false,
				clock,
			}),
		],
	)

const NO_SPLIT: Split = { fresh: [], regressed: [], ongoing: [] }

/** `ReleaseIssuesPanel`: every fingerprint this version carried, split against its first-seen. */
const issuesPanel = (
	h: H,
	model: Model,
	derived: ServiceDerived,
	impact: ReleaseServiceImpact,
	clock: Clock,
): Html => {
	const { errorFingerprints } = derived.detail
	if (errorFingerprints.length === 0)
		return issueLists(
			h,
			NO_SPLIT,
			new Map(),
			[
				"No errors carried this version.",
				"Nothing fixed before has come back.",
				"No open issue occurred on this version.",
			],
			clock,
		)
	const counts = new Map(
		errorFingerprints.slice(0, FINGERPRINT_LIMIT).map((row) => [row.fingerprintHash, row.count]),
	)
	const loaded = (wire: ReadonlyArray<Parameters<typeof errorIssueFromV2>[0]>) =>
		issueLists(
			h,
			splitIssues(wire.map(errorIssueFromV2), impact.firstSeen),
			counts,
			[
				"No issue first appeared with this version.",
				"Nothing fixed before has come back.",
				"No older issue occurred on this version.",
			],
			clock,
		)
	const loading = () =>
		h.div(
			[h.Class("grid gap-3 lg:grid-cols-3")],
			PANEL_TITLES.map((title) =>
				sectionCard(h, { title }, [skeletonList(h, { rows: 3, className: "p-2" })]),
			),
		)
	return AsyncData.match(model.serviceIssues.data, {
		onIdle: loading,
		onLoading: loading,
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load issues", variant: "row" }),
		onStale: ({ error }) =>
			errorState(h, { failure: error, title: "Couldn't load issues", variant: "row" }),
		onSuccess: loaded,
		onRefreshing: loaded,
	})
}

const seriesBar = (h: H, model: Model, serviceName: string): Html => {
	const baseline = baselineOf(model, serviceName)
	const caption =
		model.series === "version"
			? `Only spans that carried ${shortReleaseLabel(model.commitSha)}`
			: baseline === undefined
				? `Every other version of ${serviceName} in the window`
				: `Only spans that carried ${shortReleaseLabel(baseline)}, the version it replaced`
	return h.div(
		[h.Class("flex items-center justify-between gap-3")],
		[
			segmentedSelect(h, {
				size: "sm",
				ariaLabel: "Chart series",
				value: model.series,
				onChange: (series) => Message.ClickedSeries({ series }),
				options: [
					{ value: "version", label: "This version" },
					{
						value: "others",
						label: baseline === undefined ? "Other versions" : "Previous version",
					},
				],
			}),
			h.span([h.Class("text-2xs text-foreground-subtle")], [caption]),
		],
	)
}

const loadedBody = (h: H, model: Model, derived: ServiceDerived, serviceName: string, clock: Clock): Html => {
	const rail = releaseVersionsRail(h, {
		overlays: overlaysOf(model, clock),
		impacts: derived.impacts,
		currentSha: model.commitSha,
		serviceName,
		environments: model.search.environments,
		timeSearch: timeSearchOf(model),
		nowMs: clock.nowMs,
		timeZone: clock.timeZone,
	})
	const { impact } = derived
	if (impact === undefined)
		return h.div(
			[h.Class("flex flex-col gap-3")],
			[
				panel(h, {}, [
					emptyMessage(h, { className: "text-sm" }, [
						h.span([h.Class("font-mono")], [shortReleaseLabel(model.commitSha)]),
						` served no traffic on ${serviceName} in this window. Widen the time range to include its deploy.`,
					]),
				]),
				rail,
			],
		)
	const isChartReady =
		model.themeColors !== null && model.chartRuntime !== null && isChartRuntimeReady(model.chartRuntime)
	return h.div(
		[h.Class("flex flex-col gap-3")],
		[
			metaLine(h, model, impact, serviceName, clock),
			h.div([h.Class("grid gap-3 lg:grid-cols-2")], [releaseComparison(h, impact, overlaysOf(model, clock)), rail]),
			releaseChangeset(h, changesetState(model, impact.baseline?.commitSha), clock),
			seriesBar(h, model, serviceName),
			metricsGridOf(
				h,
				{
					charts: model.charts,
					rows: seriesPoints(model, derived).map((point) => ({ ...point })),
					markers: markersOf(model, derived),
					toChartMessage: (chartId, message) => Message.GotChartMessage({ chartId, message }),
					linkedCursorMount: MountLinkedCursor(),
				},
				{
					isLoading: !isChartReady,
					isWaiting: AsyncData.isRefreshing(model.detail.data),
					context:
						model.themeColors === null
							? null
							: { theme: model.themeColors, timeZone: clock.timeZone, nowMs: clock.nowMs },
				},
			),
			issuesPanel(h, model, derived, impact, clock),
		],
	)
}

const detailState = (h: H, model: Model, serviceName: string, clock: Clock): Html => {
	if (AsyncData.isIdle(model.releases.data) || AsyncData.isLoading(model.releases.data))
		return bodySkeleton(h)
	const loaded = () => {
		const derived = derivedOf(model, serviceName)
		return derived === undefined ? bodySkeleton(h) : loadedBody(h, model, derived, serviceName, clock)
	}
	return AsyncData.match(model.detail.data, {
		onIdle: () => bodySkeleton(h),
		onLoading: () => bodySkeleton(h),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load release", onRetry: Message.ClickedRetry() }),
		onStale: ({ error }) =>
			errorState(h, {
				failure: error,
				title: "Couldn't load release",
				onRetry: Message.ClickedRetry(),
			}),
		onSuccess: loaded,
		onRefreshing: loaded,
	})
}

/** `ReleaseBody`: a skeleton until the list answers the baseline, then the detail bundle. */
export const serviceBody = (h: H, model: Model, serviceName: string, clock: Clock): Html =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: CHART_TOKENS }))],
		[detailState(h, model, serviceName, clock)],
	)
