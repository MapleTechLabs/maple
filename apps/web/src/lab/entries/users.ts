import { Effect, Option, Schema, Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { dashboardPage } from "../../page/kit/dashboard-page"
import { USER_TABS, type UserTab, userLabel } from "../../page/users/data"
import { userDetailBody, userRail, userTabs, userTitle } from "../../page/users/view-detail"
import { usersFilterRail, usersGroupsBody, usersListBody } from "../../page/users/view-list"
import type { Resources } from "../../platform/resources"
import { filterUsers, scopeDetail, usersFacets, usersGroups, usersSummary } from "../users-filter"
import { noUsersState, usersLoading } from "../../page/users/view-states"
import { USER_DETAIL, USER_ROWS, USERS_NOW, USERS_SUMMARY, USERS_TIME_ZONE } from "../users-fixture"
import { defineShellLab } from "../shell-lab"

// `/lab/users`: the users directory and one user's page in the real shell, over a fixture week.
// The toolbar at the bottom switches page and state, and pins a namespace the way the org menu
// does; `?view=`, `?tab=` and `?pin=` open one directly.

const VIEWS = ["list", "detail", "empty", "loading"] as const
type View = (typeof VIEWS)[number]
const VIEW_LABEL = {
	list: "/users",
	detail: "/users/usr_4b1x9q",
	empty: "empty",
	loading: "loading",
} satisfies { readonly [K in View]: string }

/** The namespace the switcher pins, standing in for the org menu's global pin. */
const LAB_PIN = "storefront"

const Model = Schema.Struct({
	view: Schema.Literals(VIEWS),
	tab: Schema.Literals(USER_TABS),
	search: Schema.String,
	hasErrors: Schema.Boolean,
	hasReplay: Schema.Boolean,
	namespaces: Schema.Array(Schema.String),
	groups: Schema.Array(Schema.String),
	groupBy: Schema.Literals(["none", "group"]),
	filterSections: FilterSections.Model,
	pinnedNamespace: Schema.NullOr(Schema.String),
	/** The namespace picked on the user's page (the pin overrides it). */
	detailNamespace: Schema.NullOr(Schema.String),
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	ClickedView: { view: Schema.Literals(VIEWS) },
	ClickedTab: { tab: Schema.Literals(USER_TABS) },
	ChangedSearch: { value: Schema.String },
	ToggledErrors: {},
	ToggledReplay: {},
	ToggledNamespace: { name: Schema.String },
	ToggledGroup: { name: Schema.String },
	ClickedGroupBy: { groupBy: Schema.Literals(["none", "group"]) },
	ClearedFilters: {},
	GotFilterSectionsMessage: { message: FilterSections.Message },
	ToggledPin: {},
	ClearedPin: {},
	SelectedDetailNamespace: { namespace: Schema.NullOr(Schema.String) },
	Ignored: {},
})
type Message = typeof Message.Type

const Flags = Schema.Struct({
	view: Schema.Literals(VIEWS),
	tab: Schema.Literals(USER_TABS),
	pinnedNamespace: Schema.NullOr(Schema.String),
	groupBy: Schema.Literals(["none", "group"]),
})
type Flags = typeof Flags.Type

const groupByParam = (value: string | null): "none" | "group" => (value === "group" ? "group" : "none")

const decodeView = Schema.decodeUnknownOption(Schema.Literals(VIEWS))
const decodeTab = Schema.decodeUnknownOption(Schema.Literals(USER_TABS))

const init = (flags: Flags) => ({
	model: {
		view: flags.view,
		tab: flags.tab,
		search: "",
		hasErrors: false,
		hasReplay: false,
		namespaces: [],
		groups: [],
		groupBy: flags.groupBy,
		filterSections: FilterSections.init(),
		pinnedNamespace: flags.pinnedNamespace,
		detailNamespace: null,
	},
})

const toggle = (list: ReadonlyArray<string>, name: string): ReadonlyArray<string> =>
	list.includes(name) ? Arr.filter(list, (each) => each !== name) : [...list, name]

type Return = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }>

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ClickedView: ({ view }) => ({ model: { ...model, view } }),
		ClickedTab: ({ tab }) => ({ model: { ...model, tab } }),
		ChangedSearch: ({ value }) => ({ model: { ...model, search: value } }),
		ToggledErrors: () => ({ model: { ...model, hasErrors: !model.hasErrors } }),
		ToggledReplay: () => ({ model: { ...model, hasReplay: !model.hasReplay } }),
		ToggledNamespace: ({ name }) => ({ model: { ...model, namespaces: toggle(model.namespaces, name) } }),
		ToggledGroup: ({ name }) => ({ model: { ...model, groups: toggle(model.groups, name) } }),
		ClickedGroupBy: ({ groupBy }) => ({ model: { ...model, groupBy } }),
		ClearedFilters: () => ({
			model: { ...model, hasErrors: false, hasReplay: false, namespaces: [], groups: [] },
		}),
		GotFilterSectionsMessage: ({ message: inner }) => {
			const next = FilterSections.update(model.filterSections, inner)
			return {
				model: { ...model, filterSections: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotFilterSectionsMessage({ message: m }),
				),
			}
		},
		ToggledPin: () => ({
			model: { ...model, pinnedNamespace: model.pinnedNamespace === null ? LAB_PIN : null },
		}),
		ClearedPin: () => ({ model: { ...model, pinnedNamespace: null } }),
		SelectedDetailNamespace: ({ namespace }) => ({ model: { ...model, detailNamespace: namespace } }),
		Ignored: () => ({ model }),
	})

type H = HtmlBuilder<Message>

const LIST_DESCRIPTION =
	"People your SDKs identified with identify() or a user.id attribute: their sessions, errors, requests and events."

const filtersOf = (model: Model) => ({
	search: model.search,
	hasErrors: model.hasErrors,
	hasReplay: model.hasReplay,
	namespaces: model.namespaces,
	groups: model.groups,
})

const rail = (h: H, model: Model): Html =>
	usersFilterRail(h, {
		onRetry: Message.Ignored(),
		filters: filtersOf(model),
		facets: usersFacets(USER_ROWS, model.pinnedNamespace),
		pinnedNamespace: model.pinnedNamespace,
		sections: model.filterSections,
		toSectionsMessage: (message) => Message.GotFilterSectionsMessage({ message }),
		onToggleErrors: Message.ToggledErrors(),
		onToggleReplay: Message.ToggledReplay(),
		onToggleNamespace: (name) => Message.ToggledNamespace({ name }),
		onToggleGroup: (name) => Message.ToggledGroup({ name }),
		onClearNamespacePin: Message.ClearedPin(),
		onClearAll: Message.ClearedFilters(),
	})

const listPage = (h: H, model: Model, body: Html): Html =>
	dashboardPage(
		h,
		{
			filters: model.view === "list" ? rail(h, model) : undefined,
			title: "Users",
			description: LIST_DESCRIPTION,
			actions: button(h, { variant: "outline", size: "sm" }, [
				icon(h, "CalendarIcon", { size: 14 }),
				"Last 7 days",
			]),
			scrollClassName: "p-0",
		},
		[body],
	)

const detailPage = (h: H, model: Model): Html => {
	const clock = { nowMs: USERS_NOW, timeZone: USERS_TIME_ZONE }
	const active = model.pinnedNamespace ?? model.detailNamespace
	const detail = scopeDetail(USER_DETAIL, active)
	const namespace = {
		active,
		isPinned: model.pinnedNamespace !== null,
		onSelect: (next: string | null) => Message.SelectedDetailNamespace({ namespace: next }),
		onClearPin: Message.ClearedPin(),
	}
	const options = {
		tab: model.tab,
		namespace,
		nowMs: USERS_NOW,
		timeZone: USERS_TIME_ZONE,
		hrefOf: (tab: UserTab) => `?view=detail&tab=${tab}`,
		onSelectTab: (tab: UserTab) => Message.ClickedTab({ tab }),
	}
	return dashboardPage(
		h,
		{
			titleContent: userTitle(h, USER_DETAIL.profile, clock),
			actions: h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					button(h, { variant: "outline", size: "sm" }, [
						icon(h, "CopyIcon", { size: 14 }),
						"Copy user.id",
					]),
					button(h, { variant: "outline", size: "sm" }, [
						icon(h, "LayersIcon", { size: 14 }),
						"Open in traces",
					]),
					button(h, { size: "sm" }, [icon(h, "SparkleIcon", { size: 14 }), "Investigate user"]),
				],
			),
			tabs: userTabs(h, detail, options),
			rightPanel: userRail(
				h,
				detail.profile,
				clock,
				namespace,
				detail.profile.groupId === null ? null : `?view=list&groups=${detail.profile.groupId}`,
			),
			rightPanelWidth: "w-80",
			scrollClassName: "p-0",
		},
		[userDetailBody(h, detail, options)],
	)
}

const view = (model: Model, h: H): Html => {
	switch (model.view) {
		case "list": {
			const shown = filterUsers(USER_ROWS, filtersOf(model), model.pinnedNamespace)
			const summary = usersSummary(USER_ROWS, model.pinnedNamespace, USERS_SUMMARY, USERS_NOW)
			const options = {
				nowMs: USERS_NOW,
				timeZone: USERS_TIME_ZONE,
				filters: filtersOf(model),
				groupBy: model.groupBy,
				onGroupBy: (groupBy: "none" | "group") => Message.ClickedGroupBy({ groupBy }),
				scope: model.pinnedNamespace === null ? [] : [model.pinnedNamespace],
				onSearch: (value: string) => Message.ChangedSearch({ value }),
				onClearSearch: Message.ChangedSearch({ value: "" }),
			}
			return listPage(
				h,
				model,
				model.groupBy === "group"
					? usersGroupsBody(h, usersGroups(shown, USERS_NOW), summary, {
							...options,
							groupHref: (groupId) => `?view=list&groups=${groupId}`,
							truncated: false,
						})
					: usersListBody(h, shown, summary, { ...options, userHref: () => "?view=detail" }),
			)
		}
		case "detail":
			return detailPage(h, model)
		case "empty":
			return listPage(
				h,
				model,
				noUsersState(h, {
					onSetup: Message.Ignored(),
					docsHref: "#",
					onWidenRange: Message.Ignored(),
				}),
			)
		case "loading":
			return listPage(h, model, usersLoading(h))
	}
}

const viewSwitcher = (model: Model, h: H): Html =>
	h.div(
		[
			h.Class(
				"fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-raised",
			),
		],
		[
			...Arr.map(VIEWS, (each) =>
				switcherButton(h, each === model.view, Message.ClickedView({ view: each }), VIEW_LABEL[each]),
			),
			h.span([h.AriaHidden(true), h.Class("mx-1 h-4 w-px bg-border")], []),
			switcherButton(h, model.pinnedNamespace !== null, Message.ToggledPin(), `pin: ${LAB_PIN}`),
		],
	)

const switcherButton = (h: H, isActive: boolean, onClick: Message, label: string): Html =>
	h.button(
		[
			h.Type("button"),
			h.AriaPressed(String(isActive)),
			h.OnClick(onClick),
			h.Class(
				isActive
					? "rounded-md bg-accent px-2 py-1 font-mono text-xs text-foreground"
					: "rounded-md px-2 py-1 font-mono text-xs text-muted-foreground hover:text-foreground active:text-foreground",
			),
		],
		[label],
	)

export const lab = defineShellLab("Users", {
	Model,
	Message,
	Flags,
	flags: Effect.sync(() => {
		const params = new URLSearchParams(window.location.search)
		return {
			view: Option.getOrElse(decodeView(params.get("view")), (): View => "list"),
			tab: Option.getOrElse(decodeTab(params.get("tab")), (): UserTab => "activity"),
			pinnedNamespace: params.get("pin"),
			groupBy: groupByParam(params.get("groupBy")),
		}
	}),
	init,
	update,
	view,
	before: viewSwitcher,
	currentPath: "/users",
	breadcrumbs: (model) =>
		model.view === "detail"
			? [{ label: "Users" }, { label: userLabel(USER_DETAIL.profile), isPageHeading: true }]
			: [{ label: "Users", isPageHeading: true }],
})
