import { USERS_PRESETS } from "../window"
import { Submodel, AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Array as Arr } from "effect"
import type { UserListItem } from "@maple/domain/http"
import { presenceOf } from "@maple/views/data/signal-presence"
import { errorState } from "@maple/views/ui/error-state"
import { vstack } from "@maple/views/ui/stack"
import { docsUrl } from "../../../lib/docs"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { signalEmptyState } from "../../kit/signal-empty-state"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import type { UserRow } from "../data"
import {
	type UsersFacets,
	type UsersFilters,
	type UsersGroupBy,
	type UsersSummary,
	type UsersRailFacets,
	type UsersSummaryState,
	usersFilterRail,
	usersGroupsBody,
	usersListBody,
	usersToolbar,
} from "../view-list"
import { noUsersState, usersLoading } from "../view-states"
import { pinScope } from "./command"
import { Message } from "./message"
import type { Model, UsersFacetsData } from "./model"
import { DEFAULT_PRESET, groupUsersHref, isGrouped, userHref, WIDE_PRESET } from "./update"

type H = HtmlBuilder<Message>

const DESCRIPTION =
	"People your SDKs identified with identify() or a user.id attribute: their sessions, errors, requests and events."

/** A listed user as the kit row draws it. */
const toRow = (user: UserListItem): UserRow => user

const filtersOf = (model: Model): UsersFilters => ({
	search: model.query,
	hasErrors: model.search.hasErrors === true,
	hasReplay: model.search.hasReplay === true,
	namespaces: model.search.namespaces ?? [],
	groups: model.search.groups ?? [],
})

const railFacets = (facets: UsersFacetsData): UsersFacets => ({
	namespaces: facets.namespaces,
	groups: facets.groups,
	withErrors: facets.withErrors,
	withReplay: facets.withReplay,
})

/** The rail waits for the facets read too, and says when it failed instead of reading zero. */
const railFacetsStateOf = (model: Model): UsersRailFacets =>
	AsyncData.matchData(model.facets.data, {
		onEmpty: () => "loading",
		onFailure: () => "failed",
		onData: railFacets,
	})

/** The strip waits for the facets read and says so when it failed, rather than drawing zeros. */
const summaryStateOf = (model: Model): UsersSummaryState =>
	AsyncData.matchData(model.facets.data, {
		onEmpty: () => "loading",
		onFailure: () => "failed",
		onData: summaryOf,
	})

const summaryOf = (facets: UsersFacetsData): UsersSummary => ({
	identified: facets.identified,
	activeToday: facets.activeToday,
	withErrors: facets.withErrors,
	anonymousVisitors: facets.anonymousVisitors,
})

/** Whether the URL narrows the directory beyond the window and the org pin. */
const isFiltered = (model: Model): boolean => {
	const filters = filtersOf(model)
	return (
		(model.search.q ?? "") !== "" ||
		filters.hasErrors ||
		filters.hasReplay ||
		filters.namespaces.length > 0 ||
		filters.groups.length > 0
	)
}

/** No telemetry at all yet: the connect on-ramp, not the identify() one. */
const hasNoTelemetry = (model: Model): boolean =>
	presenceOf(model.presence, "traces").status === "absent" &&
	presenceOf(model.presence, "sessions").status === "absent" &&
	presenceOf(model.presence, "product_events").status === "absent"

/** Already on the month the empty state offers, or a custom range the user picked by hand. */
const isWidestWindow = (model: Model): boolean =>
	model.search.startTime !== undefined || model.search.timePreset === WIDE_PRESET

const groupByOf = (model: Model): UsersGroupBy => (isGrouped(model.search) ? "group" : "none")

const searchOptions = (model: Model) => ({
	filters: filtersOf(model),
	onSearch: (value: string) => Message.ChangedQuery({ value }),
	onClearSearch: Message.ClickedClearQuery(),
	groupBy: groupByOf(model),
	onGroupBy: (groupBy: UsersGroupBy) =>
		Message.ClickedGroupBy({ groupBy: groupBy === "none" ? null : groupBy }),
})

const signalEmpty = (h: H, model: Model): Html =>
	signalEmptyState(h, {
		signal: hasNoTelemetry(model) ? "traces" : "sessions",
		presence: presenceOf(model.presence, hasNoTelemetry(model) ? "traces" : "sessions"),
		nowMs: model.nowMs,
		noun: "users",
		isFiltered: isFiltered(model),
		onClearFilters: Message.ClickedClearSearchAndFilters(),
	})

/** A filtered empty list keeps the search box above it, so a search with no matches can be edited. */
const emptyBody = (h: H, model: Model): Html =>
	isFiltered(model)
		? vstack(h, { className: "min-w-0" }, [usersToolbar(h, searchOptions(model)), signalEmpty(h, model)])
		: hasNoTelemetry(model)
			? signalEmpty(h, model)
			: noUsersState(h, {
					onSetup: Message.ClickedSetup(),
					docsHref: docsUrl("browserSdk"),
					onWidenRange: isWidestWindow(model) ? undefined : Message.ClickedWidenRange(),
				})

const groupsBody = (h: H, model: Model, inputs: PageViewInputs): Html =>
	AsyncData.matchData(model.groups.data, {
		onEmpty: () => usersLoading(h),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load groups", onRetry: Message.ClickedRetry() }),
		onData: (page) =>
			page.groups.length === 0
				? emptyBody(h, model)
				: usersGroupsBody(h, page.groups, summaryStateOf(model), {
						nowMs: model.nowMs,
						timeZone: inputs.context.timeZone,
						...searchOptions(model),
						scope: pinScope(inputs.context.pinnedNamespace),
						groupHref: groupUsersHref(model.search),
						truncated: page.truncated,
					}),
	})

const body = (h: H, model: Model, inputs: PageViewInputs): Html =>
	isGrouped(model.search) ? groupsBody(h, model, inputs) : listBody(h, model, inputs)

const listBody = (h: H, model: Model, inputs: PageViewInputs): Html =>
	AsyncData.matchData(model.list.data, {
		onEmpty: () => usersLoading(h),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load users", onRetry: Message.ClickedRetry() }),
		onData: (page) =>
			page.users.length === 0
				? emptyBody(h, model)
				: usersListBody(h, Arr.map(page.users, toRow), summaryStateOf(model), {
						nowMs: model.nowMs,
						timeZone: inputs.context.timeZone,
						...searchOptions(model),
						scope: pinScope(inputs.context.pinnedNamespace),
						userHref: userHref(model.search),
					}),
	})

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const { search } = model
	return dashboardPage(
		h,
		{
			title: "Users",
			description: DESCRIPTION,
			filters: usersFilterRail(h, {
				filters: filtersOf(model),
				facets: railFacetsStateOf(model),
				onRetry: Message.ClickedRetry(),
				pinnedNamespace: inputs.context.pinnedNamespace,
				sections: model.filterSections,
				toSectionsMessage: (message) => Message.GotFilterSectionsMessage({ message }),
				onToggleErrors: Message.ToggledErrors(),
				onToggleReplay: Message.ToggledReplay(),
				onToggleNamespace: (name) => Message.ToggledNamespace({ name }),
				onToggleGroup: (name) => Message.ToggledGroup({ name }),
				onClearNamespacePin: Message.ClickedClearNamespacePin(),
				onClearAll: Message.ClickedClearFilters(),
			}),
			actions: timeControls(h, {
				search,
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
								search.timePreset ??
								(search.startTime === undefined ? DEFAULT_PRESET : undefined),
							presets: USERS_PRESETS,
						},
					}),
			}),
			scrollClassName: "p-0",
		},
		[body(h, model, inputs)],
	)
})
