import {
	BENCH_CLOUDFLARE_SERVICES,
	type BenchParams as LegacyBenchParams,
	DEFAULT_BENCH_PARAMS,
	DURATION_SECONDS,
	generateBenchGraph,
	refreshBenchMetrics,
} from "../../bench/service-map-bench-fixture"
import type { DeclutterFocus } from "@maple/ui/components/service-map/service-map-declutter"
import { cn } from "@maple/ui/lib/utils"
import { Effect, Option, Schema, Stream } from "effect"
import { Command, Mount, Subscription, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { pushUrl } from "foldkit/navigation"
import { AttachBenchHarness, HarnessMessage } from "../../../service-map/map/bench-harness"
import { buildSourceGraph } from "../../../service-map/map/graph"
import * as ServiceMap from "../../../service-map/map/service-map"
import { view as serviceMapView } from "../../../service-map/map/view"
import * as Canvas from "../../../service-map/xyflow/canvas"
import { eyebrow } from "../../../ui/eyebrow"
import { defineLabWithFlags } from "../../define"
import { foldLabToasts, initLabToasts, labRoot } from "../../toasts"
import * as Toast from "../../../ui/toast"

// `/lab/bench/service-map`:
// the synthetic topology at `?services=&edges=&rps=&seed=&groups=&minTraffic=&focus=`, with the
// namespace-group switch and the `window.__smBench` perf harness.

const BenchParams = Schema.Struct({
	services: Schema.Number,
	edges: Schema.Number,
	rps: Schema.Literals(["low", "med", "high"]),
	seed: Schema.Number,
	groups: Schema.Number,
	minTraffic: Schema.Number,
	focus: Schema.String,
})
type BenchParams = typeof BenchParams.Type

/** TanStack search semantics: each value is JSON when it parses, else the raw string. */
const readParams = Effect.sync((): BenchParams => {
	const search = new URLSearchParams(location.search)
	const number = (key: keyof LegacyBenchParams, fallback: number) => {
		const value = Number(search.get(key))
		return search.has(key) && Number.isFinite(value) ? value : fallback
	}
	const rps = search.get("rps")
	return {
		services: number("services", DEFAULT_BENCH_PARAMS.services),
		edges: number("edges", DEFAULT_BENCH_PARAMS.edges),
		rps: rps === "low" || rps === "med" || rps === "high" ? rps : DEFAULT_BENCH_PARAMS.rps,
		seed: number("seed", DEFAULT_BENCH_PARAMS.seed),
		groups: number("groups", DEFAULT_BENCH_PARAMS.groups),
		minTraffic: number("minTraffic", DEFAULT_BENCH_PARAMS.minTraffic),
		focus: search.get("focus") ?? DEFAULT_BENCH_PARAMS.focus,
	}
})

const Model = Schema.Struct({ params: BenchParams, map: ServiceMap.Model, toasts: Toast.Model })
type Model = typeof Model.Type

const Message = defineMessageUnion({
	GotMapMessage: { message: ServiceMap.Message },
	ClickedNamespaceGroups: { groups: Schema.Number },
	CompletedPushBenchUrl: {},
	GotHarnessMessage: { message: HarnessMessage },
	GotToastMessage: { message: Toast.Message },
})
type Message = typeof Message.Type

const toMap = (message: ServiceMap.Message): Message => Message.GotMapMessage({ message })

const initMap = (params: BenchParams) => {
	// The bench renders revision 0 of its metric refresh, not the raw generated graph.
	const graph = refreshBenchMetrics(generateBenchGraph(params), 0)
	const source = buildSourceGraph({
		edges: graph.edges,
		dbEdges: graph.dbEdges,
		serviceOverviews: graph.overviews,
		durationSeconds: DURATION_SECONDS,
		serviceWorkloads: graph.workloads,
		platforms: graph.platforms,
		runtimes: graph.runtimes,
		cloudflareServices: [...BENCH_CLOUDFLARE_SERVICES],
		faasNames: new Map(),
		planetscaleDatabases: new Map(),
		planetscaleStats: [],
	})
	const focus: Option.Option<DeclutterFocus> = params.focus
		? Option.some({ serviceId: params.focus, hops: 1, mode: "dim" })
		: Option.none()
	return ServiceMap.init(source, { minTrafficPct: params.minTraffic > 0 ? params.minTraffic : 0, focus })
}

/** `navigate({ search: (prev) => ({ ...prev, groups }) })`. */
const PushBenchGroups = Command.define("PushBenchGroups", {
	args: { groups: Schema.Number },
	messages: [Message.CompletedPushBenchUrl],
	execute: ({ groups }) =>
		Effect.sync(() => {
			const search = new URLSearchParams(location.search)
			search.set("groups", String(groups))
			return `${location.pathname}?${search}`
		}).pipe(Effect.flatMap(pushUrl), Effect.as(Message.CompletedPushBenchUrl())),
})

const init = (params: BenchParams): Update.Return<Model, Message> => {
	const map = initMap(params)
	return {
		model: { params, map: map.model, toasts: initLabToasts() },
		commands: Command.mapMessages(map.commands, toMap),
	}
}

const foldToasts = foldLabToasts<Model, Message>((message) => Message.GotToastMessage({ message }))

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match(message, {
		GotMapMessage: ({ message: mapMessage }) => {
			const next = ServiceMap.update(model.map, mapMessage)
			return {
				model: { ...model, map: next.model },
				commands: Command.mapMessages(next.commands, toMap),
			}
		},
		// The bench is keyed on its params, so a new grouping starts a fresh map.
		ClickedNamespaceGroups: ({ groups }) => {
			const fresh = init({ ...model.params, groups })
			return {
				model: { ...fresh.model, toasts: model.toasts },
				commands: [...(fresh.commands ?? []), PushBenchGroups({ groups })],
			}
		},
		CompletedPushBenchUrl: () => ({ model }),
		GotToastMessage: ({ message }) => foldToasts(model, message),
		// The perf harness pins and frames the camera the way a user gesture would.
		GotHarnessMessage: ({ message: harness }) =>
			update(
				model,
				toMap(
					HarnessMessage.match(harness, {
						RequestedCamera: ({ viewport }) =>
							ServiceMap.Message.GotCanvasMessage({
								message: Canvas.Message.ChangedViewport({ viewport }),
							}),
						RequestedFit: () => ServiceMap.Message.ClickedResort(),
					}),
				),
			),
	})

const subscriptions = Subscription.make<Model, Message>()((entry) => ({
	reducedMotion: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () => Stream.map(ServiceMap.reducedMotionChanges, toMap),
		},
	),
}))

const GROUP_OPTIONS = [0, 3, 6, 10]

/** The namespace-group switch drawn over the map. */
const groupSwitch = (h: HtmlBuilder<Message>, groups: number): Html =>
	h.div(
		[
			h.Class(
				"absolute left-1/2 top-2 z-[60] flex -translate-x-1/2 items-center gap-1 rounded-md border border-border bg-card/90 px-2 py-1 backdrop-blur-sm",
			),
		],
		[
			eyebrow(h, {}, ["Namespace groups"]),
			...GROUP_OPTIONS.map((option) =>
				h.button(
					[
						h.Type("button"),
						h.OnClick(Message.ClickedNamespaceGroups({ groups: option })),
						h.Class(
							cn(
								"rounded px-1.5 py-0.5 font-mono text-2xs transition-colors",
								option === groups
									? "bg-primary text-primary-foreground"
									: "text-muted-foreground hover:text-foreground",
							),
						),
					],
					[option === 0 ? "off" : String(option)],
				),
			),
		],
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	labRoot(h, model.toasts, (message) => Message.GotToastMessage({ message }), page(model, h))

const page = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("relative h-screen w-screen")],
		[
			groupSwitch(h, model.params.groups),
			h.div(
				[
					h.Class("h-screen w-screen bg-background"),
					h.DataAttribute("testid", "service-map-bench"),
					h.OnMount(
						Mount.mapMessage(AttachBenchHarness(), (message) =>
							Message.GotHarnessMessage({ message }),
						),
					),
				],
				[serviceMapView(h, model.map, toMap)],
			),
		],
	)

export const lab = defineLabWithFlags("Service map", {
	Model,
	Flags: BenchParams,
	flags: readParams,
	init,
	update,
	view,
	subscriptions,
})
