import { Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { expect as expectView, given, Mount, role, scene, text } from "foldkit/scene"
import { describe, test } from "vitest"
import { DEFAULT_BENCH_PARAMS, DURATION_SECONDS, generateBenchGraph } from "../../fixtures/service-map-bench-fixture"
import * as Tabs from "../../ui/tabs"
import { buildSourceGraph } from "../map/graph"
import * as ServiceMap from "../map/service-map"
import { servicePanel } from "./service-panel"

const bench = generateBenchGraph({ ...DEFAULT_BENCH_PARAMS, services: 6, edges: 8, rps: "med", seed: 5 })
const map = ServiceMap.init(
	buildSourceGraph({
		edges: bench.edges,
		dbEdges: bench.dbEdges,
		serviceOverviews: bench.overviews,
		durationSeconds: DURATION_SECONDS,
	}),
	{ minTrafficPct: 0, focus: Option.none() },
).model
const caller = bench.edges[0]
const serviceId = caller?.sourceService ?? ""
const callee = caller?.targetService ?? ""
const dbCaller = bench.dbEdges[0]

type Message = Readonly<{ _tag: "Map"; message: ServiceMap.Message }> | Readonly<{ _tag: "Tabs" }>
type Model = Readonly<{ withInfrastructure: boolean }>

const update = (model: Model) => ({ model })
const view = (model: Model, h: HtmlBuilder<Message>, selected = serviceId) =>
	servicePanel<Message>(h, {
		serviceId: selected,
		map,
		overviews: bench.overviews,
		edges: bench.edges,
		dbEdges: bench.dbEdges,
		platform: undefined,
		durationSeconds: DURATION_SECONDS,
		serviceHref: (service) => `/services/${service}`,
		tracesHref: `/traces?service=${serviceId}`,
		toMapMessage: (message) => ({ _tag: "Map", message }),
		infrastructure: model.withInfrastructure
			? {
					tabs: Tabs.init({ idBase: 60, values: ["service", "infrastructure"], selected: "service" }),
					toTabsMessage: () => ({ _tag: "Tabs" }),
					count: 2,
					content: () => [h.span([], ["the infra tab"])],
				}
			: undefined,
	})

describe("the service map's service panel", () => {
	test("lists the databases the service calls", () => {
		scene(
			{ update, view: (model: Model, h: HtmlBuilder<Message>) => view(model, h, dbCaller?.sourceService ?? "") },
			given({ withInfrastructure: false }),
			expectView(text("Databases")).toExist(),
		)
	})

	test("without an Infrastructure tab, shows the service's metrics and peers with no tab strip", () => {
		scene(
			{ update, view: (model: Model, h: HtmlBuilder<Message>) => view(model, h) },
			given({ withInfrastructure: false }),
			expectView(text(serviceId)).toExist(),
			expectView(text("Throughput")).toExist(),
			expectView(text("Dependencies")).toExist(),
			expectView(role("link", { name: "View service" })).toHaveAttr("href", `/services/${serviceId}`),
			expectView(role("link", { name: "View traces" })).toHaveAttr("href", `/traces?service=${serviceId}`),
			expectView(role("link", { name: callee })).toHaveAttr("href", `/services/${callee}`),
			expectView(role("tab", { name: /Infrastructure/ })).not.toExist(),
		)
	})

	test("with the app's Infrastructure tab, the tab strip carries its count", () => {
		scene(
			{ update, view: (model: Model, h: HtmlBuilder<Message>) => view(model, h) },
			given({ withInfrastructure: true }),
			Mount.resolve(
				Tabs.MeasureTabIndicator,
				Tabs.Message.MeasuredIndicator({ rect: { left: 0, right: 0, top: 0, bottom: 0, width: 60, height: 32 } }),
			),
			expectView(role("tab", { name: /Service/ })).toExist(),
			expectView(role("tab", { name: /Infrastructure\s*2/ })).toExist(),
		)
	})
})
