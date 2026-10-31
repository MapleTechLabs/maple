import { OrgId } from "@maple/domain"
import { Effect, Option, Result, Schema } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { fromString as urlFromString } from "foldkit/url"
import type { PageContext, PageReturn } from "../../page/contract"
import { Message as PeekMessage } from "../../page/services/detail/endpoint-peek/message"
import { Message as PageMessage } from "../../page/services/detail/message"
import { Model as PageModel } from "../../page/services/detail/model"
import * as DetailUpdate from "../../page/services/detail/update"
import { view as pageView } from "../../page/services/detail/view"
import type { Resources } from "../../platform/resources"
import { urlToAppRoute } from "../../route"
import {
	LAB_API_OVERVIEW,
	LAB_ENDPOINT_DETAILS,
	LAB_ENDPOINT_SERIES,
	LAB_ENDPOINTS,
	LAB_NOW,
	LAB_STATUS_ROWS,
} from "../service-api-fixture"
import { defineShellLab } from "../shell-lab"

// `/lab/service-api[?endpoint=POST%20/v1/traces]`: the service page's API tab and endpoint drawer
// over 12 hours of the ingest service, in the real shell. Reads are dropped, nothing leaves the tab.

const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_service_api"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const Flags = Schema.Struct({ endpoint: Schema.NullOr(Schema.String) })
type Flags = typeof Flags.Type

const Model = Schema.Struct({ page: PageModel })
type Model = typeof Model.Type

const Message = defineMessageUnion({ GotPageMessage: { message: PageMessage } })
type Message = typeof Message.Type
type Return = Update.Return<Model, Message, Resources>

/** The build running at the window start, then one deploy at 11:41 (the first is the baseline). */
const RELEASES = [
	{ bucket: "2026-10-24T03:00:00.000Z", commitSha: "a81d0c4", count: 400, errorCount: 0 },
	{ bucket: "2026-10-24T11:41:00.000Z", commitSha: "3f9c21a", count: 120, errorCount: 0 },
]

const isPending = (data: AsyncData.AsyncData<unknown, unknown>) => AsyncData.isLoading(data) || AsyncData.isRefreshing(data)

/** The answers to every read still pending, as the Messages their fetches would have sent. */
const answers = (model: PageModel): ReadonlyArray<PageMessage> => [
	...(isPending(model.overview.data)
		? [
				PageMessage.CompletedFetchOverview({
					key: model.overview.key ?? "",
					result: Result.succeed({ points: [], releases: RELEASES, environments: ["production"] }),
				}),
			]
		: []),
	...(isPending(model.endpoints.data)
		? [PageMessage.CompletedFetchEndpoints({ key: model.endpoints.key ?? "", result: Result.succeed(LAB_ENDPOINTS) })]
		: []),
	...(isPending(model.apiOverview.data)
		? [PageMessage.CompletedFetchApiOverview({ key: model.apiOverview.key ?? "", result: Result.succeed(LAB_API_OVERVIEW) })]
		: []),
	...(isPending(model.statusBreakdown.data)
		? [
				PageMessage.CompletedFetchStatusBreakdown({
					key: model.statusBreakdown.key ?? "",
					result: Result.succeed(LAB_STATUS_ROWS),
				}),
			]
		: []),
	...(isPending(model.endpointSeries.data)
		? [
				PageMessage.CompletedFetchEndpointSeries({
					key: model.endpointSeries.key ?? "",
					result: Result.succeed(LAB_ENDPOINT_SERIES),
				}),
			]
		: []),
	...Object.entries(model.endpointPeek.details).flatMap(([spanName, slot]) => {
		const detail = LAB_ENDPOINT_DETAILS.get(spanName)
		return isPending(slot.data) && detail !== undefined
			? [
					PageMessage.GotEndpointPeekMessage({
						message: PeekMessage.CompletedFetchDetail({ spanName, key: slot.key ?? "", result: Result.succeed(detail) }),
					}),
				]
			: []
	}),
]

/** Answers pending reads until none is left (an answer can start the next read). */
const settle = (result: PageReturn<PageModel, PageMessage>, depth = 0): PageReturn<PageModel, PageMessage> => {
	const pending = answers(result.model)
	if (pending.length === 0 || depth > 6) return result
	const next = pending.reduce<PageReturn<PageModel, PageMessage>>((acc, message) => {
		const answered = DetailUpdate.update(acc.model, message, CONTEXT)
		return {
			model: answered.model,
			commands: [...(acc.commands ?? []), ...(answered.commands ?? [])],
			outMessage: acc.outMessage ?? answered.outMessage,
		}
	}, result)
	return settle(next, depth + 1)
}

const isRead = (name: string) => /^(Fetch|ResolveServiceDetailClock)/.test(name)

const step = (result: PageReturn<PageModel, PageMessage>): Return => {
	const settled = settle(result)
	return {
		model: { page: settled.model },
		commands: Command.mapMessages(
			(settled.commands ?? []).filter((command) => !isRead(command.name)),
			(message) => Message.GotPageMessage({ message }),
		),
	}
}

/** The page's URL writes, applied to its own search the way a route change would. */
const follow = (model: PageModel, url: string): PageReturn<PageModel, PageMessage> =>
	Option.match(urlFromString(new URL(url, "http://localhost").href), {
		onNone: () => ({ model }),
		onSome: (parsed) => {
			const route = urlToAppRoute(parsed)
			return route._tag === "Service" ? DetailUpdate.routeChanged(model, route, CONTEXT) : { model }
		},
	})

const init = (flags: Flags): Return => {
	const started = DetailUpdate.init(
		{ serviceName: "ingest", search: { tab: "api", endpoint: flags.endpoint ?? undefined } },
		CONTEXT,
	)
	const clocked = DetailUpdate.update(
		started.model,
		PageMessage.CompletedResolveClock({ nowMs: LAB_NOW, mode: "Load" }),
		CONTEXT,
	)
	return step({ ...clocked, commands: [...(started.commands ?? []), ...(clocked.commands ?? [])] })
}

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPageMessage: ({ message: inner }) => {
			const next = DetailUpdate.update(model.page, inner, CONTEXT)
			const out = next.outMessage
			if (out === undefined || out._tag !== "RequestedNavigation") return step(next)
			const followed = follow(next.model, out.url)
			return step({ ...followed, commands: [...(next.commands ?? []), ...(followed.commands ?? [])] })
		},
	})

const view = (model: Model, h: HtmlBuilder<Message>) =>
	h.submodel({
		slotId: "service-api-lab",
		model: model.page,
		view: pageView,
		viewInputs: { context: CONTEXT },
		toParentMessage: (message: PageMessage) => Message.GotPageMessage({ message }),
	})

export const lab = defineShellLab("Service API", {
	Model,
	Message,
	Flags,
	flags: Effect.sync(() => ({ endpoint: new URLSearchParams(window.location.search).get("endpoint") })),
	init,
	update,
	view,
	currentPath: "/lab/service-api",
	breadcrumbs: [{ label: "Services" }, { label: "ingest" }],
})
