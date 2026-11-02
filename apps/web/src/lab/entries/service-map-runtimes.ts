import { formatWarehouseDateTime } from "@maple/query-engine"
import { OrgId } from "@maple/domain"
import { Effect, Option, Result, Schema, Stream } from "effect"
import { AsyncData, Command, Subscription, type Update } from "foldkit"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { resolveWindow } from "../../data/time-range"
import type { PageContext, PageReturn } from "../../page/contract"
import { Message as PageMessage } from "../../page/service-map/message"
import {
	CloudflareStats,
	MapBundle,
	Model as PageModel,
	PlanetScaleStats,
} from "../../page/service-map/model"
import * as MapUpdate from "../../page/service-map/update"
import { view as pageView } from "../../page/service-map/view"
import type { Resources } from "../../platform/resources"
import * as ServiceMap from "../../service-map/map/service-map"
import * as Tabs from "../../ui/tabs"
import {
	MAP_RUNTIMES_BUNDLE,
	MAP_RUNTIMES_ENVIRONMENTS,
	MAP_RUNTIMES_NOW,
	MAP_RUNTIMES_SELECTED,
} from "../service-map-runtimes-fixture"
import { defineShellLab } from "../shell-lab"

// `/lab/service-map-runtimes[?tab=infrastructure]`: the service map over the fleet topology with
// `fleet-api` selected, its side panel on the Service or Infrastructure tab. Reads are answered.

const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_service_map_runtimes"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const PanelTab = Schema.Literals(["service", "infrastructure"])

const Flags = Schema.Struct({ tab: PanelTab })
type Flags = typeof Flags.Type

/** `isPrimed` once the lab selected the node: a later deselect is the user's. */
const Model = Schema.Struct({ page: PageModel, tab: PanelTab, isPrimed: Schema.Boolean })
type Model = typeof Model.Type

const Message = defineMessageUnion({ GotPageMessage: { message: PageMessage } })
type Message = typeof Message.Type
type Return = Update.Return<Model, Message, Resources>
type PageResult = PageReturn<PageModel, PageMessage>

const isPending = (data: AsyncData.AsyncData<unknown, unknown>) =>
	AsyncData.isLoading(data) || AsyncData.isRefreshing(data)

type Answer = (model: PageModel) => ReadonlyArray<PageMessage>

const slot =
	<S extends { readonly key: string | null; readonly data: AsyncData.AsyncData<unknown, unknown> }>(
		read: (model: PageModel) => S,
		answer: (key: string) => PageMessage,
	): Answer =>
	(model) => {
		const target = read(model)
		return isPending(target.data) ? [answer(target.key ?? "")] : []
	}

/** Every read the page makes; adding a read is one more entry. */
const ANSWERS: ReadonlyArray<Answer> = [
	slot(
		(model) => model.facets,
		(key) => PageMessage.CompletedFetchFacets({ key, result: Result.succeed(MAP_RUNTIMES_ENVIRONMENTS) }),
	),
	slot(
		(model) => model.bundle,
		(key) =>
			PageMessage.CompletedFetchBundle({
				key,
				result: Result.succeed(new MapBundle(MAP_RUNTIMES_BUNDLE)),
			}),
	),
	slot(
		(model) => model.cloudflare,
		(key) =>
			PageMessage.CompletedFetchCloudflare({
				key,
				result: Result.succeed(new CloudflareStats({ services: [] })),
			}),
	),
	slot(
		(model) => model.planetscaleStats,
		(key) =>
			PageMessage.CompletedFetchPlanetScaleStats({
				key,
				result: Result.succeed(new PlanetScaleStats({ databases: [] })),
			}),
	),
	slot(
		(model) => model.planetscaleInventory,
		(key) => PageMessage.CompletedFetchPlanetScaleInventory({ key, result: Result.succeed([]) }),
	),
	slot(
		(model) => model.hyperdrives,
		(key) => PageMessage.CompletedFetchHyperdrives({ key, result: Result.succeed([]) }),
	),
	(model) =>
		AsyncData.isLoading(model.presence)
			? [
					PageMessage.CompletedLoadSignalPresence({
						result: Result.succeed({
							traces: { status: "present", lastSeenMs: MAP_RUNTIMES_NOW },
						}),
					}),
				]
			: [],
]

const answers = (model: PageModel): ReadonlyArray<PageMessage> => ANSWERS.flatMap((answer) => answer(model))

const merge = (acc: PageResult, next: PageResult): PageResult => ({
	model: next.model,
	commands: [...(acc.commands ?? []), ...(next.commands ?? [])],
	outMessage: acc.outMessage ?? next.outMessage,
})

const apply = (result: PageResult, messages: ReadonlyArray<PageMessage>): PageResult =>
	messages.reduce<PageResult>(
		(acc, message) => merge(acc, MapUpdate.update(acc.model, message, CONTEXT)),
		result,
	)

/** Answers pending reads until none is left (an answer can start the next read). */
const settle = (result: PageResult, depth = 0): PageResult => {
	const pending = answers(result.model)
	return pending.length === 0 || depth > 6 ? result : settle(apply(result, pending), depth + 1)
}

/** Once the map exists: select the service, then open the requested panel tab. */
const prime = (result: PageResult, tab: Flags["tab"]): PageResult =>
	apply(result, [
		PageMessage.GotMapMessage({
			message: ServiceMap.Message.PickedNode({ nodeId: MAP_RUNTIMES_SELECTED }),
		}),
		...(tab === "infrastructure"
			? [PageMessage.GotServiceTabsMessage({ message: Tabs.Message.ClickedTab({ index: 1 }) })]
			: []),
	])

/** Network reads and the clock are answered here; local Commands (storage, chart runtime) run. */
const isRead = (name: string) => /^(Fetch|ResolveServiceMapWindow|LoadServiceMapSignalPresence)/.test(name)

const step = (result: PageResult, tab: Flags["tab"], isPrimed: boolean): Return => {
	const settled = settle(result)
	const shouldPrime = !isPrimed && Option.isSome(settled.model.map)
	const primed = shouldPrime ? prime(settled, tab) : settled
	return {
		model: { page: primed.model, tab, isPrimed: isPrimed || shouldPrime },
		commands: Command.mapMessages(
			(primed.commands ?? []).filter((command) => !isRead(command.name)),
			(message) => Message.GotPageMessage({ message }),
		),
	}
}

const PRESET = "1h"

const init = (flags: Flags): Return => {
	const started = MapUpdate.init({ search: { timePreset: PRESET } }, CONTEXT)
	const resolved = MapUpdate.update(
		started.model,
		PageMessage.CompletedResolveWindow({
			window: resolveWindow(
				{ preset: PRESET, snap: true, timeZone: CONTEXT.timeZone },
				MAP_RUNTIMES_NOW,
			),
			timeZone: CONTEXT.timeZone,
			facetsWindow: {
				startTime: formatWarehouseDateTime(MAP_RUNTIMES_NOW - 24 * 60 * 60 * 1000),
				endTime: formatWarehouseDateTime(MAP_RUNTIMES_NOW),
			},
			nowMs: MAP_RUNTIMES_NOW,
			mode: "Load",
		}),
		CONTEXT,
	)
	return step(merge(started, resolved), flags.tab, false)
}

/** URL writes (focus, environment) are dropped: the lab stays on its one view. */
const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPageMessage: ({ message: inner }) =>
			step(MapUpdate.update(model.page, inner, CONTEXT), model.tab, model.isPrimed),
	})

/** The page's reduced-motion feed, once the map exists. */
const subscriptions = Subscription.make<Model, Message>()((entry) => ({
	reducedMotion: entry(
		{ hasMap: Schema.Boolean },
		{
			modelToDependencies: (model) => ({ hasMap: Option.isSome(model.page.map) }),
			dependenciesToStream: ({ hasMap }) =>
				hasMap
					? Stream.map(ServiceMap.reducedMotionChanges, (message) =>
							Message.GotPageMessage({ message: PageMessage.GotMapMessage({ message }) }),
						)
					: Stream.empty,
		},
	),
}))

const view = (model: Model, h: HtmlBuilder<Message>) =>
	h.submodel({
		slotId: "service-map-runtimes-lab",
		model: model.page,
		view: pageView,
		viewInputs: { context: CONTEXT },
		toParentMessage: (message: PageMessage) => Message.GotPageMessage({ message }),
	})

export const lab = defineShellLab("Service map runtimes", {
	Model,
	Message,
	Flags,
	flags: Effect.sync((): Flags => ({
		tab:
			new URLSearchParams(window.location.search).get("tab") === "infrastructure"
				? "infrastructure"
				: "service",
	})),
	init,
	update,
	view,
	subscriptions,
	currentPath: "/lab/service-map-runtimes",
	breadcrumbs: [{ label: "Service map" }],
})
