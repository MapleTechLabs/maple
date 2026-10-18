import { Array, Option, Schema } from "effect"
import { Subscription } from "foldkit"
import type { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Resources } from "../platform/resources"
import type { AppRoute } from "../route"
import type { BreadcrumbEntry } from "../shell"
import type {
	PageContext,
	PageHost,
	PageMessageBase,
	PageOutMessage,
	PageSlotBase,
	PageStep,
	PageViewInputs,
} from "./contract"
import * as AlertsHub from "./alerts/hub"
import * as AlertIncident from "./alerts/incident"
import * as AlertRule from "./alerts/rule"
import * as CodeReviewAnalytics from "./code-review/analytics"
import * as CodeReviewIssues from "./code-review/issues"
import * as CodeReviewPullRequests from "./code-review/pull-requests"
import * as ErrorsHub from "./errors/hub"
import * as ErrorIssue from "./errors/issue"
import * as LogsList from "./logs/list"
import * as MetricsBrowse from "./metrics/browse"
import * as MetricDetail from "./metrics/detail"
import * as Overview from "./overview"
import * as ServiceDetail from "./services/detail"
import * as ServiceMap from "./service-map"
import * as ServicesList from "./services/list"
import * as TraceDetail from "./traces/detail"
import * as TracesList from "./traces/list"

/**
 * Every ported page, registered once. Adding a page: import its module and append `X.page` below;
 * that is the only shared file a page touches. Shell routes without a page render the placeholder.
 */
export const pages = [
	ServicesList.page,
	Overview.page,
	MetricsBrowse.page,
	MetricDetail.page,
	ErrorsHub.page,
	ErrorIssue.page,
	TracesList.page,
	TraceDetail.page,
	LogsList.page,
	ServiceDetail.page,
	AlertsHub.page,
	AlertIncident.page,
	AlertRule.page,
	ServiceMap.page,
	CodeReviewAnalytics.page,
	CodeReviewPullRequests.page,
	CodeReviewIssues.page,
]

export const PageSlot = Schema.Union(pages.map((page) => page.Slot))
export type PageSlot = typeof PageSlot.Type

export const PageMessage = Schema.Union(pages.map((page) => page.Wrapped))
export type PageMessage = typeof PageMessage.Type

/** The page slot after a transition, with the Commands and OutMessage that came with it. */
export interface PageTransition {
	readonly slot: PageSlot | null
	readonly commands: ReadonlyArray<Command.Command<PageMessage, never, Resources>>
	readonly outMessage: Option.Option<PageOutMessage>
}

const unchanged = (slot: PageSlot | null): PageTransition => ({
	slot,
	commands: [],
	outMessage: Option.none(),
})

const toTransition = (step: Option.Option<PageStep<PageSlot, PageMessage>>, fallback: PageSlot | null) =>
	Option.match(step, { onNone: () => unchanged(fallback), onSome: (found): PageTransition => found })

const pageById = (id: string) => Array.findFirst(pages, (page) => page.id === id)

/**
 * Route entry: keep the instance when its key and org are unchanged (it gets `routeChanged`),
 * otherwise build the route's page and drop the previous one (React's unmount on navigation).
 */
export const enterRoute = (current: PageSlot | null, route: AppRoute, context: PageContext): PageTransition =>
	Option.match(
		Array.findFirst(pages, (page) => Option.isSome(page.keyOf(route))),
		{
			onNone: () => unchanged(null),
			onSome: (page) => {
				const isSameInstance =
					current !== null &&
					current._tag === page.id &&
					current.orgId === context.orgId &&
					Option.contains(page.keyOf(route), current.key)
				return isSameInstance
					? toTransition(page.routeChanged(current, route, context), current)
					: toTransition(page.init(route, context), null)
			},
		},
	)

export const updatePage = (
	current: PageSlot | null,
	message: PageMessageBase,
	context: PageContext,
): PageTransition =>
	current === null
		? unchanged(current)
		: Option.match(pageById(message._tag), {
				onNone: () => unchanged(current),
				onSome: (page) => toTransition(page.update(current, message, context), current),
			})

export const changeContext = (current: PageSlot | null, context: PageContext): PageTransition =>
	current === null
		? unchanged(current)
		: Option.match(pageById(current._tag), {
				onNone: () => unchanged(current),
				onSome: (page) => toTransition(page.contextChanged(current, context), current),
			})

export const pageBreadcrumbs = (slot: PageSlotBase): ReadonlyArray<BreadcrumbEntry> =>
	Option.match(pageById(slot._tag), { onNone: () => [], onSome: (page) => page.breadcrumbs(slot) })

export const pageSubscriptions = Subscription.aggregate<PageHost, PageMessage, Resources>()(
	...pages.map((page) => page.subscriptions),
)

/** Embeds the active page. `slotId` includes the key, so a new instance gets a fresh boundary. */
export const viewPage = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	slot: PageSlotBase,
	inputs: PageViewInputs,
	toParentMessage: (message: PageMessage) => ParentMessage,
): Html =>
	Option.match(pageById(slot._tag), {
		onNone: () => h.empty,
		onSome: (page) =>
			h.submodel({
				slotId: `page:${slot._tag}:${slot.key}`,
				model: slot,
				view: page.hostView,
				viewInputs: inputs,
				toParentMessage,
			}),
	})
