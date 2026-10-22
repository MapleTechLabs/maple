import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as Select from "../../../ui/select"
import * as Tabs from "../../../ui/tabs"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { SignalPresenceData } from "../../kit/signal-presence"
import {
	CreateQuestion,
	FetchInvestigations,
	FetchMoreInvestigations,
	FetchTriageBudget,
	LoadInvestigationsPresence,
	PAGE_SIZE,
	ReadInvestigationsClock,
	ReadInvestigationsIsAdmin,
	WaitInvestigationsSearch,
} from "./command"
import {
	isLoadingMoreOf,
	KIND_FILTER_VALUES,
	nextCursorOf,
	SORT_OPTIONS,
	type Search,
	sortValueOf,
	viewOf,
} from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

const VIEWS = ["active", "history"]

const firstPageKey = (context: PageContext) =>
	requestKey(context.orgId, "investigations.list", { query: { limit: PAGE_SIZE } })

const loadFirstPage = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const key = firstPageKey(context)
	return Option.match(Keyed.request(model.firstPage, key, mode), {
		onNone: () => ({ model }),
		onSome: (firstPage) => ({ model: { ...model, firstPage }, commands: [FetchInvestigations({ key })] }),
	})
}

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const search = route.search
	const budgetKey = requestKey(context.orgId, "aiTriage.getSettings", {})
	const model: Model = {
		search,
		nowMs: 0,
		firstPage: Keyed.idle(),
		morePages: [],
		budget: { key: budgetKey, data: AsyncData.Loading() },
		presence: SignalPresenceData.Loading(),
		subject: "",
		isCreating: false,
		isOrgAdmin: !isClerkAuthEnabled,
		searchDraft: search.q ?? "",
		searchGeneration: 0,
		tabs: Tabs.init({ idBase: 0, values: VIEWS, selected: viewOf(search) }),
		kindSelect: Select.init("investigations-kind", {
			value: search.kind ?? "all",
			selectedIndex: KIND_FILTER_VALUES.indexOf(search.kind ?? "all"),
		}),
		sortSelect: Select.init("investigations-sort", {
			value: sortValueOf(search),
			selectedIndex: SORT_OPTIONS.findIndex((option) => option.value === sortValueOf(search)),
		}),
	}
	const loaded = loadFirstPage(model, context, "Load")
	return {
		model: loaded.model,
		commands: [
			LoadInvestigationsPresence({ orgId: context.orgId }),
			ReadInvestigationsClock(),
			...(loaded.commands ?? []),
			FetchTriageBudget({ key: budgetKey }),
			...(isClerkAuthEnabled ? [ReadInvestigationsIsAdmin({ orgId: context.orgId })] : []),
		],
	}
}

const searchHref = (search: Search) => hrefOf(AppRoute.Investigations({ search }))

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	_context: PageContext,
): Return => {
	const search = route.search
	if (searchHref(model.search) === searchHref(search)) return { model }
	return {
		model: {
			...model,
			search,
			searchDraft:
				(model.searchDraft.trim() || undefined) === search.q ? model.searchDraft : (search.q ?? ""),
			tabs: {
				...model.tabs,
				selected: viewOf(search),
				highlightedIndex: VIEWS.indexOf(viewOf(search)),
			},
			kindSelect: { ...model.kindSelect, value: search.kind ?? "all" },
			sortSelect: { ...model.sortSelect, value: sortValueOf(search) },
		},
	}
}

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: searchHref(search), isReplace: false }),
})

const isKind = (value: string): value is NonNullable<Search["kind"]> =>
	KIND_FILTER_VALUES.some((kind) => kind !== "all" && kind === value)

const selectStep = (
	model: Model,
	select: Select.Model,
	message: Select.Message,
	write: (select: Select.Model) => Partial<Model>,
	wrap: (message: Select.Message) => Message,
	onChange: (model: Model, value: string) => Return,
): Return => {
	const next = Select.update(select, message)
	const updated = { ...model, ...write(next.model) }
	const commands: Commands = Command.mapMessages(next.commands ?? [], wrap)
	if (next.outMessage === undefined) return { model: updated, commands }
	const navigation = onChange(updated, next.outMessage.value)
	return { ...navigation, commands: [...commands, ...(navigation.commands ?? [])] }
}

const create = (model: Model, title: string): Return =>
	title === "" || model.isCreating
		? { model }
		: { model: { ...model, subject: "", isCreating: true }, commands: [CreateQuestion({ title })] }

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchFirstPage: ({ key, result }) => ({
			model: { ...model, firstPage: Keyed.accept(model.firstPage, key, result) },
		}),
		CompletedFetchMorePage: ({ key, cursor, result }) => ({
			model: {
				...model,
				morePages: model.morePages.map((more) =>
					more.cursor === cursor ? { cursor, page: Keyed.accept(more.page, key, result) } : more,
				),
			},
		}),
		CompletedFetchBudget: ({ key, result }) => ({
			model: { ...model, budget: Keyed.accept(model.budget, key, result) },
		}),
		CompletedReadIsAdmin: ({ orgId, isAdmin }) =>
			orgId === context.orgId ? { model: { ...model, isOrgAdmin: isAdmin } } : { model },
		ClickedRetry: () => loadFirstPage(model, context, "Refresh"),
		ClickedLoadMore: () => {
			const cursor = nextCursorOf(model)
			if (
				cursor === null ||
				isLoadingMoreOf(model) ||
				model.morePages.some((more) => more.cursor === cursor)
			)
				return { model }
			const key = requestKey(context.orgId, "investigations.list", {
				query: { limit: PAGE_SIZE, cursor },
			})
			return {
				model: {
					...model,
					morePages: [...model.morePages, { cursor, page: { key, data: AsyncData.Loading() } }],
				},
				commands: [FetchMoreInvestigations({ key, cursor })],
			}
		},
		ChangedSubject: ({ value }) => ({ model: { ...model, subject: value } }),
		SubmittedSubject: () => create(model, model.subject.trim()),
		ClickedSuggestion: ({ title }) => create(model, title),
		CompletedCreate: ({ result }) =>
			Result.match(result, {
				// The create invalidates the `investigations` reactivity key, so the list is re-read as it leaves.
				onSuccess: (id) => ({
					...loadFirstPage({ ...model, isCreating: false }, context, "Refresh"),
					outMessage: PageOutMessage.RequestedNavigation({
						url: hrefOf(AppRoute.Investigation({ id, search: {} })),
						isReplace: false,
					}),
				}),
				onFailure: (failure) => ({
					model: { ...model, isCreating: false },
					outMessage: PageOutMessage.RequestedToast({
						type: "error",
						title: failure.title,
						description: failure.message,
					}),
				}),
			}),
		ChangedSearchDraft: ({ value }) => {
			const searchGeneration = model.searchGeneration + 1
			return {
				model: { ...model, searchDraft: value, searchGeneration },
				commands: [WaitInvestigationsSearch({ generation: searchGeneration })],
			}
		},
		ElapsedSearchDebounce: ({ generation }) => {
			const q = model.searchDraft.trim() || undefined
			return generation === model.searchGeneration && q !== model.search.q
				? navigate(model, { ...model.search, q })
				: { model }
		},
		ClickedClearFilters: () => navigate(model, { ...model.search, kind: undefined, q: undefined }),
		ClickedRow: ({ id }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.Investigation({ id, search: {} })),
				isReplace: false,
			}),
		}),
		CompletedLoadSignalPresence: ({ result }) => ({
			model: { ...model, presence: AsyncData.settle(model.presence, result) },
		}),
		GotTabsMessage: ({ message: inner }) => {
			const next = Tabs.update(model.tabs, inner)
			const updated = { ...model, tabs: next.model }
			const commands: Commands = Command.mapMessages(next.commands ?? [], (tabs) =>
				Message.GotTabsMessage({ message: tabs }),
			)
			if (inner._tag !== "ClickedTab") return { model: updated, commands }
			const value = model.tabs.values[inner.index]
			if (value === undefined || value === model.tabs.selected) return { model: updated, commands }
			return {
				...navigate(updated, { ...model.search, view: value === "history" ? "history" : undefined }),
				commands,
			}
		},
		GotKindSelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.kindSelect,
				inner,
				(kindSelect) => ({ kindSelect }),
				(next) => Message.GotKindSelectMessage({ message: next }),
				(next, value) => navigate(next, { ...model.search, kind: isKind(value) ? value : undefined }),
			),
		GotSortSelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.sortSelect,
				inner,
				(sortSelect) => ({ sortSelect }),
				(next) => Message.GotSortSelectMessage({ message: next }),
				(next, value) => {
					const [key, direction] = value.split(":")
					const sort = key === "severity" || key === "confidence" ? key : undefined
					return navigate(next, {
						...model.search,
						sort,
						dir: direction === "desc" ? undefined : "asc",
					})
				},
			),
	})
