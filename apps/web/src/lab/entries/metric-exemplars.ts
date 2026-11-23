import { OrgId } from "@maple/domain"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { AsyncData, Command, type Update } from "foldkit"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { fromString as urlFromString } from "foldkit/url"
import { Effect, Option, Result, Schema, Array as Arr } from "effect"
import type { PageContext, PageReturn } from "../../page/contract"
import { Message as PageMessage } from "../../page/metrics/detail/message"
import { AutocompleteLookup, Model as PageModel } from "../../page/metrics/detail/model"
import * as DetailUpdate from "../../page/metrics/detail/update"
import { view as pageView } from "../../page/metrics/detail/view"
import type { Resources } from "../../platform/resources"
import { urlToAppRoute } from "../../route"
import {
	EXEMPLARS_CATALOG,
	EXEMPLARS_DISTRIBUTION,
	EXEMPLARS_METRIC,
	EXEMPLARS_NOW,
	EXEMPLARS_ROWS,
	EXEMPLARS_TIMESERIES,
} from "../metric-exemplars-fixture"
import { defineShellLab } from "../shell-lab"
import { bucketKey, cellKeyParts } from "../../page/metrics/detail/exemplars"

// `/lab/metric-exemplars`: the metric page for a latency histogram over one hour, in the real
// shell: exemplar dots on the p95 line, the Distribution heatmap (?display=distribution), the
// Exemplars table. `?state=empty` has no exemplars, `?state=failed` fails both reads.

const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_metric_exemplars"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const LabState = Schema.Literals(["loaded", "empty", "failed"])
type LabState = typeof LabState.Type

const Flags = Schema.Struct({ state: LabState, distribution: Schema.Boolean })
type Flags = typeof Flags.Type

const Model = Schema.Struct({ page: PageModel, state: LabState })
type Model = typeof Model.Type

const Message = defineMessageUnion({ GotPageMessage: { message: PageMessage } })
type Message = typeof Message.Type
type Return = Update.Return<Model, Message, Resources>

const isPending = (data: AsyncData.AsyncData<unknown, unknown>) =>
	AsyncData.isLoading(data) || AsyncData.isRefreshing(data)

const WINDOW = { startTime: "2026-11-22 14:00:00", endTime: "2026-11-22 15:00:00" }

const failedOr = <A>(state: LabState, value: A) =>
	state === "failed" ? Result.fail(toLoadFailure("warehouse unreachable")) : Result.succeed(value)

/** The fixture's exemplars in the picked cell: its minute and its value range. */
const cellRows = (cellKey: string | null) => {
	const parts = cellKey === null ? null : cellKeyParts(cellKey)
	const row =
		parts === null
			? undefined
			: Option.getOrUndefined(
					Arr.findFirst(
						EXEMPLARS_DISTRIBUTION,
						(candidate) => candidate.bucket === parts.x && bucketKey(candidate) === parts.y,
					),
				)
	return row === undefined
		? []
		: Arr.filter(
				EXEMPLARS_ROWS,
				(exemplar) =>
					exemplar.bucket === row.bucket &&
					(row.lowerBound === null || exemplar.value > row.lowerBound) &&
					(row.upperBound === null || exemplar.value <= row.upperBound),
			)
}

/** The answers to every read still pending, as the Messages their fetches would have sent. */
const answers = (model: PageModel, state: LabState): ReadonlyArray<PageMessage> => [
	...(model.window === null
		? [PageMessage.CompletedResolveWindow({ window: WINDOW, nowMs: EXEMPLARS_NOW, mode: "Load" })]
		: []),
	...(isPending(model.catalog.data)
		? [
				PageMessage.CompletedFetchCatalog({
					key: model.catalog.key ?? "",
					result: Result.succeed(EXEMPLARS_CATALOG),
				}),
			]
		: []),
	...Arr.flatMap(AutocompleteLookup.literals, (lookup) => {
		const slot = model.autocomplete[lookup]
		return slot !== undefined && isPending(slot.data)
			? [
					PageMessage.CompletedFetchAutocomplete({
						lookup,
						key: slot.key ?? "",
						result: Result.succeed({}),
					}),
				]
			: []
	}),
	...(isPending(model.attributeKeys.data)
		? [
				PageMessage.CompletedFetchAttributeKeys({
					key: model.attributeKeys.key ?? "",
					result: Result.succeed([
						{ attributeKey: "http.route", usageCount: 14_100 },
						{ attributeKey: "http.request.method", usageCount: 14_100 },
					]),
				}),
			]
		: []),
	...(isPending(model.timeseries.data)
		? [
				PageMessage.CompletedFetchTimeseries({
					key: model.timeseries.key ?? "",
					result: Result.succeed(EXEMPLARS_TIMESERIES),
				}),
			]
		: []),
	...(isPending(model.breakdown.data)
		? [
				PageMessage.CompletedFetchBreakdown({
					key: model.breakdown.key ?? "",
					result: Result.succeed([
						{ name: "checkout-api", value: 0.31 },
						{ name: "payments-worker", value: 0.12 },
					]),
				}),
			]
		: []),
	...(isPending(model.exemplars.data)
		? [
				PageMessage.CompletedFetchExemplars({
					key: model.exemplars.key ?? "",
					result: failedOr(state, state === "empty" ? [] : EXEMPLARS_ROWS),
				}),
			]
		: []),
	...(isPending(model.cellExemplars.data)
		? [
				PageMessage.CompletedFetchCellExemplars({
					key: model.cellExemplars.key ?? "",
					result: failedOr(state, state === "empty" ? [] : cellRows(model.selectedCell)),
				}),
			]
		: []),
	...(isPending(model.distribution.data)
		? [
				PageMessage.CompletedFetchDistribution({
					key: model.distribution.key ?? "",
					result: failedOr(state, { rows: EXEMPLARS_DISTRIBUTION, bucketSeconds: 60 }),
				}),
			]
		: []),
]

/** Answers pending reads until none is left (an answer can start the next read). */
const settle = (
	result: PageReturn<PageModel, PageMessage>,
	state: LabState,
	depth = 0,
): PageReturn<PageModel, PageMessage> => {
	const pending = answers(result.model, state)
	if (pending.length === 0 || depth > 6) return result
	const next = Arr.reduce(pending, result, (acc, message): PageReturn<PageModel, PageMessage> => {
		const answered = DetailUpdate.update(acc.model, message, CONTEXT)
		return {
			model: answered.model,
			commands: [...(acc.commands ?? []), ...(answered.commands ?? [])],
			outMessage: acc.outMessage ?? answered.outMessage,
		}
	})
	return settle(next, state, depth + 1)
}

const isRead = (name: string) => /^(Fetch|Resolve)/.test(name)

const step = (result: PageReturn<PageModel, PageMessage>, state: LabState): Return => {
	const settled = settle(result, state)
	return {
		model: { page: settled.model, state },
		commands: Command.mapMessages(
			Arr.filter(settled.commands ?? [], (command) => !isRead(command.name)),
			(message) => Message.GotPageMessage({ message }),
		),
	}
}

/** The page's URL writes (the display toggle), applied the way a route change would be. */
const follow = (model: PageModel, url: string): PageReturn<PageModel, PageMessage> =>
	Option.match(urlFromString(new URL(url, "http://localhost").href), {
		onNone: () => ({ model }),
		onSome: (parsed) => {
			const route = urlToAppRoute(parsed)
			return route._tag === "Metric" ? DetailUpdate.routeChanged(model, route, CONTEXT) : { model }
		},
	})

const init = (flags: Flags): Return =>
	step(
		DetailUpdate.init(
			{
				metricName: EXEMPLARS_METRIC,
				search: {
					agg: "p95",
					timePreset: "1h",
					...(flags.distribution ? { display: "distribution" as const } : undefined),
				},
			},
			CONTEXT,
		),
		flags.state,
	)

/** A display switch is followed in place; a trace link stays in the lab. */
const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPageMessage: ({ message: inner }) => {
			const next = DetailUpdate.update(model.page, inner, CONTEXT)
			const out = next.outMessage
			if (out === undefined || out._tag !== "RequestedNavigation") return step(next, model.state)
			const followed = follow(next.model, out.url)
			return step(
				{ ...followed, commands: [...(next.commands ?? []), ...(followed.commands ?? [])] },
				model.state,
			)
		},
	})

const view = (model: Model, h: HtmlBuilder<Message>) =>
	h.submodel({
		slotId: "metric-exemplars-lab",
		model: model.page,
		view: pageView,
		viewInputs: { context: CONTEXT },
		toParentMessage: (message: PageMessage) => Message.GotPageMessage({ message }),
	})

const decodeState = Schema.decodeUnknownOption(LabState)

export const lab = defineShellLab("Metric exemplars", {
	Model,
	Message,
	Flags,
	flags: Effect.sync(() => {
		const params = new URLSearchParams(window.location.search)
		return {
			state: Option.getOrElse(decodeState(params.get("state")), (): LabState => "loaded"),
			distribution: params.get("display") === "distribution",
		}
	}),
	init,
	update,
	view,
	currentPath: "/lab/metric-exemplars",
	breadcrumbs: [{ label: "Metrics" }, { label: EXEMPLARS_METRIC }],
})
