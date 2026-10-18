import type { ErrorIssueDocument, VcsCommitRangeResponse } from "@maple/domain/http"
import { attributeIssues, previousSha, shortReleaseLabel } from "@maple/web/components/releases/release-model"
import { errorIssueFromV2 } from "@maple/web/lib/services/error-issues"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { BreadcrumbEntry } from "../../../shell"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { pageTitle } from "../../../ui/page-layout"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { commitAvatar, commitRangesKey, firstLine, isResolvableSha } from "../kit"
import { DEFAULT_PRESET, deriveOf } from "../list/derive"
import { groupOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { type ChangesetState, type Clock, deploySummary, deployServices, issueList, releaseChangeset } from "./view-sections"

// `ReleaseDetailPage` (apps/web/src/routes/releases/$commitSha.tsx) without a `service`: `ReleaseDeployOverview`.
// TODO(release-service): the service-scoped body (`ReleaseBody`: comparison, versions rail, metrics
// grid with commit markers, issues by fingerprint) is not ported; it renders the deploy overview.

type H = HtmlBuilder<Message>

const plainSha = (h: H, sha: string, label: string): Html => h.span([h.Class("truncate font-mono"), h.Title(sha)], [label])

/** `ReleaseTitle`: the commit message once the sha resolves, the short sha until then. */
const releaseTitle = (h: H, model: Model): Html => {
	if (!isResolvableSha(model.commitSha)) return plainSha(h, model.commitSha, model.commitSha)
	return Option.match(AsyncData.getData(model.commit.data), {
		onNone: () => plainSha(h, model.commitSha, shortReleaseLabel(model.commitSha)),
		onSome: (commit) => {
			const subject = firstLine(commit.message)
			return h.span(
				[h.Class("flex min-w-0 items-center gap-2.5")],
				[
					commitAvatar(h, commit.authorAvatarUrl, commit.authorLogin ?? commit.authorName ?? "Unknown author", false),
					subject
						? h.span([h.Class("truncate"), h.Title(subject)], [subject])
						: plainSha(h, model.commitSha, shortReleaseLabel(model.commitSha)),
				],
			)
		},
	})
}

const changesetState = (model: Model, base: string | undefined): ChangesetState => {
	if (base === undefined) return { _tag: "NoBase" }
	if (commitRangesKey([{ base, head: model.commitSha }]) === "") return { _tag: "NotShas" }
	return AsyncData.match(model.changeset.data, {
		onIdle: (): ChangesetState => ({ _tag: "Loading", base }),
		onLoading: (): ChangesetState => ({ _tag: "Loading", base }),
		onFailure: (): ChangesetState => ({ _tag: "Unavailable", base }),
		onStale: (): ChangesetState => ({ _tag: "Unavailable", base }),
		onSuccess: (ranges) => loadedState(ranges),
		onRefreshing: (ranges) => loadedState(ranges),
	})
	function loadedState(ranges: ReadonlyArray<VcsCommitRangeResponse>): ChangesetState {
		const range = ranges[0]
		return range === undefined || range.status === "unavailable" || base === undefined
			? { _tag: "Unavailable", base: base ?? "" }
			: { _tag: "Loaded", base, range }
	}
}

const deployIssues = (h: H, model: Model, clock: Clock): Html => {
	const group = Option.getOrUndefined(groupOf(model))
	if (group === undefined) return h.empty
	const data = AsyncData.getOrElse(model.releases.data, () => null)
	const impacts = data === null ? [] : deriveOf(data).impacts
	return AsyncData.match(model.issues.data, {
		onIdle: () => skeleton(h, "h-32 w-full rounded-md"),
		onLoading: () => skeleton(h, "h-32 w-full rounded-md"),
		onFailure: (failure) => errorState(h, { failure, title: "Issues could not be loaded", variant: "row" }),
		onStale: ({ error }) => errorState(h, { failure: error, title: "Issues could not be loaded", variant: "row" }),
		onSuccess: (issues) => lists(issues),
		onRefreshing: (issues) => lists(issues),
	})
	function lists(wire: ReadonlyArray<Parameters<typeof errorIssueFromV2>[0]>): Html {
		const documents: Array<ErrorIssueDocument> = wire.map(errorIssueFromV2)
		const split = attributeIssues(impacts, documents).get(model.commitSha) ?? { fresh: [], regressed: [] }
		const isServiceShown = (group?.services.length ?? 0) > 1
		return h.div(
			[h.Class("grid gap-3 lg:grid-cols-2")],
			[
				issueList(h, {
					title: "New with this release",
					issues: split.fresh,
					empty: "No issue first appeared while this release was live.",
					tone: "error",
					isServiceShown,
					clock,
				}),
				issueList(h, {
					title: "Regressed with this release",
					issues: split.regressed,
					empty: "Nothing fixed before came back while this release was live.",
					tone: "warn",
					isServiceShown,
					clock,
				}),
			],
		)
	}
}

const overview = (h: H, model: Model, clock: Clock): Html => {
	return AsyncData.match(model.releases.data, {
		onIdle: () => loading(h),
		onLoading: () => loading(h),
		onFailure: (failure) => errorState(h, { failure, title: "Failed to load release", onRetry: Message.ClickedRetry() }),
		onStale: ({ error }) => errorState(h, { failure: error, title: "Failed to load release", onRetry: Message.ClickedRetry() }),
		onSuccess: () => loaded(),
		onRefreshing: () => loaded(),
	})
	function loaded(): Html {
		return Option.match(groupOf(model), {
			onNone: () =>
				panel(h, {}, [
					emptyMessage(h, { className: "text-sm" }, [
						h.span([h.Class("font-mono")], [shortReleaseLabel(model.commitSha)]),
						" served no traffic in this window. Widen the time range to include its deploy.",
					]),
				]),
			onSome: (group) =>
				h.div(
					[h.Class("flex flex-col gap-3")],
					[
						deploySummary(h, group, clock),
						deployServices(h, group, model.search.environments, {
							startTime: model.search.startTime,
							endTime: model.search.endTime,
							timePreset: model.search.timePreset,
						}),
						releaseChangeset(h, changesetState(model, previousSha(group)), clock),
						deployIssues(h, model, clock),
					],
				),
		})
	}
}

const loading =(h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-3")],
		[skeleton(h, "h-4 w-80"), skeleton(h, "h-48 w-full rounded-md"), skeleton(h, "h-48 w-full rounded-md")],
	)

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(
		h,
		{
			titleContent: pageTitle(h, { className: "flex min-w-0 items-center gap-2.5" }, [releaseTitle(h, model)]),
			actions: timeControls(h, {
				search: model.search,
				defaultPreset: DEFAULT_PRESET,
				window: model.window,
				onReset: Message.ClickedResetTimeRange(),
				onReload: Message.ClickedReload(),
				isReloading: model.isReloading,
				trigger: (label) =>
					h.submodel({
						slotId: "release-time-range-picker",
						model: model.timePicker,
						view: TimeRangePicker.view,
						toParentMessage: (message) => Message.GotTimePickerMessage({ message }),
						viewInputs: {
							label,
							selectedPreset: model.search.timePreset ?? (model.search.startTime === undefined ? DEFAULT_PRESET : undefined),
							presets: TimeRangePicker.LONG_RANGE_PRESET_VALUES,
						},
					}),
			}),
		},
		[overview(h, model, { nowMs: model.nowMs, timeZone: inputs.context.timeZone })],
	),
)

export const breadcrumbsOf = (model: Model): ReadonlyArray<BreadcrumbEntry> =>
	model.search.service === undefined
		? [{ label: "Releases", href: "/releases" }, { label: shortReleaseLabel(model.commitSha) }]
		: [
				{ label: "Releases", href: "/releases" },
				{ label: shortReleaseLabel(model.commitSha), href: `/releases/${model.commitSha}` },
				{ label: model.search.service },
			]
