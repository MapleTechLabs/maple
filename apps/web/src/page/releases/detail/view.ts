import type { ErrorIssueDocument } from "@maple/domain/http"
import { attributeIssues, previousSha, shortReleaseLabel } from "../../../components/releases/release-model"
import { errorIssueFromV2 } from "../../../lib/services/error-issues"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { BreadcrumbEntry } from "../../../shell"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { pageTitle } from "@maple/views/ui/page-layout"
import { panel } from "@maple/views/ui/panel"
import { skeleton, skeletonBlock } from "@maple/views/ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { commitAvatar, firstLine, isResolvableSha } from "../kit"
import { DEFAULT_PRESET, deriveOf } from "../list/derive"
import { groupOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { changesetState, overlaysOf, serviceBody, serviceButton } from "./view-service"
import { type Clock, deploySummary, deployServices, issueList, releaseChangeset } from "./view-sections"
import { typography } from "@maple/views/ui/typography"
import { hstack, hstackClass, vstack } from "@maple/views/ui/stack"
import { grid } from "@maple/views/ui/grid"

// The release detail page: the deploy overview, or with `?service=` the service body
// (view-service.ts).

type H = HtmlBuilder<Message>

const plainSha = (h: H, sha: string, label: string): Html =>
	typography(h, { mono: true, truncate: true, attributes: [h.Title(sha)] }, [label])

/** `ReleaseTitle`: the commit message once the sha resolves, the short sha until then. */
const releaseTitle = (h: H, model: Model): Html => {
	if (!isResolvableSha(model.commitSha)) return plainSha(h, model.commitSha, model.commitSha)
	return Option.match(AsyncData.getData(model.commit.data), {
		onNone: () => plainSha(h, model.commitSha, shortReleaseLabel(model.commitSha)),
		onSome: (commit) => {
			const subject = firstLine(commit.message)
			return hstack(h, { gap: "2.5", shrink: true, as: "span" }, [
				commitAvatar(
					h,
					commit.authorAvatarUrl,
					commit.authorLogin ?? commit.authorName ?? "Unknown author",
					false,
				),
				subject
					? h.span([h.Class("truncate"), h.Title(subject)], [subject])
					: plainSha(h, model.commitSha, shortReleaseLabel(model.commitSha)),
			])
		},
	})
}

const deployIssues = (h: H, model: Model, clock: Clock): Html => {
	const group = Option.getOrUndefined(groupOf(model))
	if (group === undefined) return h.empty
	const data = AsyncData.getOrElse(model.releases.data, () => null)
	const impacts = data === null ? [] : deriveOf(data).impacts
	return AsyncData.match(model.issues.data, {
		onIdle: () => skeletonBlock(h, { height: "32" }),
		onLoading: () => skeletonBlock(h, { height: "32" }),
		onFailure: (failure) => errorState(h, { failure, title: "Couldn't load issues", variant: "row" }),
		onStale: ({ error }) =>
			errorState(h, { failure: error, title: "Couldn't load issues", variant: "row" }),
		onSuccess: (issues) => lists(issues),
		onRefreshing: (issues) => lists(issues),
	})
	function lists(wire: ReadonlyArray<Parameters<typeof errorIssueFromV2>[0]>): Html {
		const documents: Array<ErrorIssueDocument> = wire.map(errorIssueFromV2)
		const split = attributeIssues(impacts, documents).get(model.commitSha) ?? { fresh: [], regressed: [] }
		const isServiceShown = (group?.services.length ?? 0) > 1
		return grid(h, { lg: 2, gap: "3" }, [
			issueList(h, {
				title: "New with this release",
				issues: split.fresh,
				empty: "No issue first appeared while this release was live",
				tone: "error",
				isServiceShown,
				clock,
			}),
			issueList(h, {
				title: "Regressed with this release",
				issues: split.regressed,
				empty: "Nothing fixed before came back while this release was live",
				tone: "warn",
				isServiceShown,
				clock,
			}),
		])
	}
}

const overview = (h: H, model: Model, clock: Clock): Html => {
	return AsyncData.match(model.releases.data, {
		onIdle: () => loading(h),
		onLoading: () => loading(h),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load release", onRetry: Message.ClickedRetry() }),
		onStale: ({ error }) =>
			errorState(h, {
				failure: error,
				title: "Couldn't load release",
				onRetry: Message.ClickedRetry(),
			}),
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
				vstack(h, { gap: "3" }, [
					deploySummary(h, group, clock),
					deployServices(
						h,
						group,
						model.search.environments,
						{
							startTime: model.search.startTime,
							endTime: model.search.endTime,
							timePreset: model.search.timePreset,
						},
						overlaysOf(model, clock),
					),
					releaseChangeset(h, changesetState(model, previousSha(group)), clock),
					deployIssues(h, model, clock),
				]),
		})
	}
}

const loading = (h: H): Html =>
	vstack(h, { gap: "3" }, [
		skeleton(h, "h-4 w-80"),
		skeletonBlock(h, { height: "48" }),
		skeletonBlock(h, { height: "48" }),
	])

const timeControlsOf = (h: H, model: Model): Html =>
	timeControls(h, {
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
					selectedPreset:
						model.search.timePreset ??
						(model.search.startTime === undefined ? DEFAULT_PRESET : undefined),
					presets: TimeRangePicker.LONG_RANGE_PRESET_VALUES,
				},
			}),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const clock = { nowMs: model.nowMs, timeZone: inputs.context.timeZone }
	const service = model.search.service
	return dashboardPage(
		h,
		{
			titleContent: pageTitle(h, { className: hstackClass({ gap: "2.5", shrink: true }) }, [
				releaseTitle(h, model),
			]),
			actions:
				service === undefined
					? timeControlsOf(h, model)
					: hstack(h, { gap: "2", wrap: true }, [
							serviceButton(h, model, service),
							timeControlsOf(h, model),
						]),
		},
		[service === undefined ? overview(h, model, clock) : serviceBody(h, model, service, clock)],
	)
})

export const breadcrumbsOf = (model: Model): ReadonlyArray<BreadcrumbEntry> =>
	model.search.service === undefined
		? [{ label: "Releases", href: "/releases" }, { label: shortReleaseLabel(model.commitSha) }]
		: [
				{ label: "Releases", href: "/releases" },
				{ label: shortReleaseLabel(model.commitSha), href: `/releases/${model.commitSha}` },
				{ label: model.search.service },
			]
