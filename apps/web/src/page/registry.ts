import { Array, Option, Predicate, Schema } from "effect"
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
import * as AgentSessionsList from "./agent-sessions/list"
import * as AgentSession from "./agent-sessions/session"
import * as AgentSessionTool from "./agent-sessions/tool"
import * as AgentSessionTools from "./agent-sessions/tools"
import * as AlertEditor from "./alerts/editor"
import * as AlertsHub from "./alerts/hub"
import * as AnomaliesList from "./anomalies/list"
import * as AnomalyDetail from "./anomalies/detail"
import * as AlertIncident from "./alerts/incident"
import * as AlertRule from "./alerts/rule"
import * as DashboardsList from "./dashboards/list"
import * as DashboardTemplates from "./dashboards/templates"
import * as DashboardView from "./dashboards/view"
import * as DashboardWidget from "./dashboards/widget"
import * as Chat from "./chat/page"
import * as CodeReview from "./code-review"
import * as ErrorsHub from "./errors/hub"
import * as ErrorIssue from "./errors/issue"
import * as InfraContainer from "./infra/containers/detail"
import * as InfraContainers from "./infra/containers/list"
import * as InfraHost from "./infra/hosts/detail"
import * as InfraHosts from "./infra/hosts/list"
import * as InfraKubernetesNode from "./infra/kubernetes/node"
import * as InfraKubernetesNodes from "./infra/kubernetes/nodes"
import * as InfraKubernetesPod from "./infra/kubernetes/pod"
import * as InfraKubernetesPods from "./infra/kubernetes/pods"
import * as InfraKubernetesService from "./infra/kubernetes/service"
import * as InfraKubernetesWorkload from "./infra/kubernetes/workload"
import * as InfraKubernetesWorkloads from "./infra/kubernetes/workloads"
import * as InfraOverview from "./infra/overview"
import * as InfraCloudflare from "./infra-integrations/cloudflare/list"
import * as InfraCloudflareWorker from "./infra-integrations/cloudflare/worker"
import * as InfraCloudflareZone from "./infra-integrations/cloudflare/zone"
import * as InfraGcp from "./infra-integrations/gcp/list"
import * as InfraGcpWorkload from "./infra-integrations/gcp/workload"
import * as InfraPlanetscaleDatabase from "./infra-integrations/planetscale/db"
import * as InfraPlanetscale from "./infra-integrations/planetscale/list"
import * as InfraRailway from "./infra-integrations/railway/list"
import * as InfraRailwayService from "./infra-integrations/railway/service"
import * as InfraSupabase from "./infra-integrations/supabase/list"
import * as InfraSupabaseProject from "./infra-integrations/supabase/project"
import * as Integrations from "./integrations"
import * as InvestigationDetail from "./investigations/detail"
import * as InvestigationsList from "./investigations/list"
import * as LogsList from "./logs/list"
import * as LogPage from "./logs/log"
import * as MetricsBrowse from "./metrics/browse"
import * as Analytics from "./analytics"
import * as MetricDetail from "./metrics/detail"
import * as Overview from "./overview"
import * as Recommendation from "./recommendations"
import * as ReleaseDetail from "./releases/detail"
import * as ReleasesList from "./releases/list"
import * as ServiceDetail from "./services/detail"
import * as ServiceMap from "./service-map"
import * as ReplayDetail from "./replays/detail"
import * as ReplaysList from "./replays/list"
import * as ServicesList from "./services/list"
import * as Settings from "./settings"
import * as Account from "./settings/account"
import * as McpPage from "./settings/mcp-page"
import * as Share from "./share"
import * as SourcesList from "./sources/list"
import * as SourcesNew from "./sources/new"
import * as SourceDetail from "./sources/detail"
import * as TraceDetail from "./traces/detail"
import * as TracesList from "./traces/list"

/**
 * Every page, registered once. Adding a page: import its module and append `X.page` below;
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
	LogPage.page,
	ServiceDetail.page,
	AlertsHub.page,
	AlertIncident.page,
	AlertRule.page,
	AlertEditor.page,
	ServiceMap.page,
	InfraHosts.page,
	InfraHost.page,
	InfraContainers.page,
	InfraContainer.page,
	InfraKubernetesPods.page,
	InfraKubernetesPod.page,
	InfraKubernetesNodes.page,
	InfraKubernetesNode.page,
	InfraKubernetesWorkloads.page,
	InfraKubernetesWorkload.page,
	InfraKubernetesService.page,
	InfraOverview.page,
	InfraRailway.page,
	InfraRailwayService.page,
	InfraSupabase.page,
	InfraSupabaseProject.page,
	InfraPlanetscale.page,
	InfraPlanetscaleDatabase.page,
	InfraGcp.page,
	InfraGcpWorkload.page,
	InfraCloudflare.page,
	InfraCloudflareWorker.page,
	InfraCloudflareZone.page,
	DashboardsList.page,
	DashboardView.page,
	DashboardTemplates.page,
	DashboardWidget.page,
	CodeReview.page,
	AgentSessionsList.page,
	AgentSessionTools.page,
	AgentSessionTool.page,
	AgentSession.page,
	Integrations.page,
	Recommendation.page,
	AnomaliesList.page,
	AnomalyDetail.page,
	ReleasesList.page,
	ReleaseDetail.page,
	InvestigationsList.page,
	InvestigationDetail.page,
	Settings.page,
	McpPage.page,
	SourcesList.page,
	SourcesNew.page,
	SourceDetail.page,
	Account.page,
	ReplaysList.page,
	ReplayDetail.page,
	Share.page,
	Analytics.page,
	Chat.page,
]

/** Public routes a page renders bare, outside the shell (`/share/$token`). */
const BARE_PAGE_ROUTES: ReadonlyArray<AppRoute["_tag"]> = ["Share"]

export const isBarePageRoute = (route: AppRoute): boolean => BARE_PAGE_ROUTES.includes(route._tag)

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
 * otherwise revive a parked instance of the route's page or build it, as instance `nextInstance`.
 */
export const enterRoute = (
	current: PageSlot | null,
	route: AppRoute,
	context: PageContext,
	nextInstance: number,
	parked: ReadonlyArray<PageSlot> = [],
): PageTransition =>
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
				if (isSameInstance) return toTransition(page.routeChanged(current, route, context), current)
				const revived = Option.flatMap(
					Array.findFirst(
						parked,
						(slot) => slot._tag === page.id && Option.contains(page.keyOf(route), slot.key),
					),
					(slot): Option.Option<PageStep<PageSlot, PageMessage>> =>
						page.revive(slot, route, context, nextInstance),
				)
				return Option.isSome(revived)
					? toTransition(revived, null)
					: toTransition(page.init(route, context, nextInstance), null)
			},
		},
	)

const ASYNC_DATA_TAGS: ReadonlyArray<string> = [
	"Idle",
	"Loading",
	"Refreshing",
	"Failure",
	"Stale",
	"Success",
]

/** Some `AsyncData` in the Model is in flight; its answer would be dropped while parked. */
const hasLoadInFlight = (value: unknown): boolean => {
	if (Array.isArray(value)) return value.some(hasLoadInFlight)
	if (!Predicate.isReadonlyObject(value)) return false
	const tag = value["_tag"]
	// An `AsyncData`'s own data holds no requests: rows are not walked.
	if (Predicate.isString(tag) && ASYNC_DATA_TAGS.includes(tag))
		return tag === "Loading" || tag === "Refreshing"
	return Object.values(value).some(hasLoadInFlight)
}

/** How many left pages are kept to revive; each holds its last data. */
const PARKED_PAGES_MAX = 4

/** The parked pages after leaving `left` for `entered`: newest first, the entered one taken out. */
export const parkPages = (
	parked: ReadonlyArray<PageSlot>,
	left: PageSlot | null,
	entered: PageSlot | null,
): ReadonlyArray<PageSlot> => {
	const isLeft =
		left !== null &&
		pageIdentity(left) !== pageIdentity(entered) &&
		Array.some(pages, (page) => page.id === left._tag && page.isRevivable) &&
		!hasLoadInFlight(left.model)
	const sameSlot = (a: PageSlotBase, b: PageSlotBase) => a._tag === b._tag && a.key === b.key
	return [...(isLeft ? [left] : []), ...parked]
		.filter((slot) => entered === null || (slot.orgId === entered.orgId && !sameSlot(slot, entered)))
		.filter((slot, index, all) => all.findIndex((other) => sameSlot(other, slot)) === index)
		.slice(0, PARKED_PAGES_MAX)
}

/** Link intent (`page/preload.ts`): the route's page's preload Commands, or none. */
export const preloadRoute = (
	route: AppRoute,
	context: PageContext,
	nowMs: number,
): ReadonlyArray<Command.Command<PageMessage, never, Resources>> =>
	Option.getOrElse(
		Array.findFirst(pages, (page) => Option.isSome(page.keyOf(route))).pipe(
			Option.flatMap(
				(page): Option.Option<ReadonlyArray<Command.Command<PageMessage, never, Resources>>> =>
					page.preload(route, context, nowMs),
			),
		),
		() => [],
	)

/** A page instance's identity: a new one starts with nothing held. */
export const pageIdentity = (slot: PageSlotBase | null): string =>
	slot === null ? "" : `${slot._tag}:${slot.key}:${slot.orgId}:${slot.instance}`

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

const toHeld = (step: Option.Option<PageStep<PageSlot, PageMessage>>): Option.Option<PageTransition> => step

/**
 * `useBlocker`: a navigation to `route` that would drop the open instance, held by a page that
 * blocks it; `None` lets it through (no page, a page that allows it, or the same instance).
 */
export const blockNavigation = (
	current: PageSlot | null,
	route: AppRoute,
	url: string,
	context: PageContext,
): Option.Option<PageTransition> => {
	if (current === null) return Option.none()
	const isSameInstance = Array.some(
		pages,
		(page) => page.id === current._tag && Option.contains(page.keyOf(route), current.key),
	)
	if (isSameInstance) return Option.none()
	return Option.flatMap(pageById(current._tag), (page) =>
		toHeld(page.blockedNavigation(current, url, context)),
	)
}

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

/** The page's view boundary: a new instance (another org on the same route, too) mounts afresh. */
export const pageSlotId = (slot: PageSlotBase): string => `page:${pageIdentity(slot)}`

/** Embeds the active page under `pageSlotId`. */
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
				slotId: pageSlotId(slot),
				model: slot,
				view: page.hostView,
				viewInputs: inputs,
				toParentMessage,
			}),
	})

/** The active page's top-bar actions (`DashboardPage topbarActions`), or nothing. */
export const viewPageTopbarActions = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	slot: PageSlotBase,
	inputs: PageViewInputs,
	toParentMessage: (message: PageMessage) => ParentMessage,
): Html =>
	Option.match(pageById(slot._tag), {
		onNone: () => h.empty,
		onSome: (page) =>
			h.submodel({
				slotId: `page-topbar:${pageIdentity(slot)}`,
				model: slot,
				view: page.hostTopbarActions,
				viewInputs: inputs,
				toParentMessage,
			}),
	})
