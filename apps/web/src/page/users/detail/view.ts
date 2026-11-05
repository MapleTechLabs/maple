import { USERS_PRESETS } from "../window"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Option } from "effect"
import type { UserProfileItem } from "@maple/domain/http"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { errorState } from "@maple/views/ui/error-state"
import type { BreadcrumbEntry } from "../../../shell/view-topbar"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { resourceNotFound } from "../../kit/resource-not-found"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { type UserTab, userLabel } from "../data"
import {
	type UserGroupStats,
	userDetailBody,
	type UserDetailOptions,
	userRail,
	userTabs,
	userTitle,
} from "../view-detail"
import { userDetailLoading, userRowsLoading } from "../view-states"
import { activeNamespace } from "./command"
import { groupUsersHref, toUserDetail } from "./data-map"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET, tabOf, userDetailHref } from "./update"

type H = HtmlBuilder<Message>

const profileOf = (model: Model): UserProfileItem | null =>
	Option.getOrElse(
		Option.flatMap(AsyncData.getData(model.profile.data), (data) => Option.fromNullishOr(data.profile)),
		() => null,
	)

export const breadcrumbs = (model: Model): ReadonlyArray<BreadcrumbEntry> => {
	const profile = profileOf(model)
	return [
		{ label: "Users", href: "/users" },
		{ label: profile === null ? model.userId : userLabel(profile), isPageHeading: profile !== null },
	]
}

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

const actions = (h: H, model: Model): Html =>
	timeControls(h, {
		search: model.search,
		defaultPreset: DEFAULT_PRESET,
		window: model.window,
		onReset: Message.ClickedResetTimeRange(),
		onReload: Message.ClickedReload(),
		isReloading: model.isReloading,
		trigger: (label) =>
			h.submodel({
				slotId: "time-range-picker",
				model: model.timePicker,
				view: TimeRangePicker.view,
				toParentMessage: toTimePicker,
				viewInputs: {
					label,
					selectedPreset:
						model.search.timePreset ??
						(model.search.startTime === undefined ? DEFAULT_PRESET : undefined),
					presets: USERS_PRESETS,
				},
			}),
	})

/** The tabs read from the activity answer; Errors, Traces and Logs have their own reads. */
const ACTIVITY_TABS: ReadonlySet<UserTab> = new Set(["activity", "sessions", "events", "mcp"])

/** A loading or failed read, drawn in place of the tab's rows. */
const readState = <A>(h: H, data: AsyncData.AsyncData<A, LoadFailure>, title: string): Html | undefined =>
	AsyncData.matchData(data, {
		onEmpty: (): Html | undefined => userRowsLoading(h),
		onFailure: (failure): Html | undefined =>
			errorState(h, { failure, title, onRetry: Message.ClickedRetry() }),
		onData: (): Html | undefined => undefined,
	})

/** The open tab's read state: the activity read's tabs, Errors, Traces and Logs. */
const tabState = (h: H, model: Model, tab: UserTab): Html | undefined => {
	if (ACTIVITY_TABS.has(tab)) return readState(h, model.activity.data, "Couldn't load this user's activity")
	if (tab === "errors") return readState(h, model.issues.data, "Couldn't load this user's errors")
	if (tab === "traces") return readState(h, model.traces.data, "Couldn't load this user's requests")
	if (tab === "logs") return readState(h, model.logs.data, "Couldn't load this user's logs")
	return undefined
}

const userPage = (h: H, model: Model, profile: UserProfileItem, inputs: PageViewInputs): Html => {
	const pinned = inputs.context.pinnedNamespace
	const active = activeNamespace(model.search, pinned)
	const namespace = {
		active,
		isPinned: pinned !== null,
		onSelect: (next: string | null) => Message.ClickedNamespace({ namespace: next }),
		onClearPin: Message.ClickedClearNamespacePin(),
	}
	const clock = { nowMs: model.nowMs, timeZone: inputs.context.timeZone }
	const tab = tabOf(model.search)
	const detail = toUserDetail(
		profile,
		Option.getOrUndefined(AsyncData.getData(model.activity.data)),
		model.search,
		{
			issues: Option.getOrUndefined(AsyncData.getData(model.issues.data)),
			traces: Option.getOrUndefined(AsyncData.getData(model.traces.data)),
			logs: Option.getOrUndefined(AsyncData.getData(model.logs.data)),
		},
	)
	const tabContent = tabState(h, model, tab)
	const options: UserDetailOptions<Message> = {
		tab,
		namespace,
		nowMs: model.nowMs,
		timeZone: inputs.context.timeZone,
		hrefOf: (next) => userDetailHref(model.userId, { ...model.search, tab: next }),
		onSelectTab: (next) => Message.ClickedTab({ tab: next }),
		tabContent,
	}
	return dashboardPage(
		h,
		{
			titleContent: userTitle(h, detail.profile, clock),
			actions: actions(h, model),
			tabs: userTabs(h, detail, options),
			rightPanel: userRail(
				h,
				detail.profile,
				clock,
				namespace,
				detail.profile.groupId === null ? null : groupUsersHref(detail.profile.groupId, model.search),
				groupStatsOf(model),
			),
			rightPanelWidth: "w-80",
			scrollClassName: "p-0",
		},
		[userDetailBody(h, detail, options)],
	)
}

/** The rail's group numbers: none until the overview names a group, then the read's state. */
const groupStatsOf = (model: Model): UserGroupStats =>
	model.groupStats.key === null
		? null
		: AsyncData.matchData(model.groupStats.data, {
				onEmpty: (): UserGroupStats => "loading",
				onFailure: (): UserGroupStats => "failed",
				onData: ({ group }): UserGroupStats => group,
			})

/** No signal in the window and scope carries this id. */
const notFound = (h: H, model: Model, inputs: PageViewInputs): Html => {
	const active = activeNamespace(model.search, inputs.context.pinnedNamespace)
	return resourceNotFound(h, {
		title: "No activity from this user",
		description: `No session, product event, span or log carried user.id ${model.userId} in this time range${active === null ? "" : ` under the ${active} namespace`}. Widen the range, or check the id.`,
		back: { href: "/users", label: "All users" },
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	AsyncData.matchData(model.profile.data, {
		onEmpty: () =>
			dashboardPage(h, { title: model.userId, actions: actions(h, model), scrollClassName: "p-0" }, [
				userDetailLoading(h),
			]),
		onFailure: (failure) =>
			dashboardPage(h, { title: model.userId, actions: actions(h, model) }, [
				errorState(h, { failure, title: "Couldn't load this user", onRetry: Message.ClickedRetry() }),
			]),
		onData: ({ profile }) =>
			profile === null
				? dashboardPage(h, { title: model.userId, actions: actions(h, model) }, [
						notFound(h, model, inputs),
					])
				: userPage(h, model, profile, inputs),
	}),
)
