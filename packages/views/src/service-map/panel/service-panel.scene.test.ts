import { Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { expect as expectView, given, Mount, role, scene, text } from "foldkit/scene"
import { describe, test } from "vitest"
import {
	DEFAULT_BENCH_PARAMS,
	DURATION_SECONDS,
	generateBenchGraph,
} from "../../fixtures/service-map-bench-fixture"
import * as Tabs from "../../ui/tabs"
import { buildSourceGraph } from "../map/graph"
import * as ServiceMap from "../map/service-map"
import { servicePanel } from "./service-panel"
import { classifyServiceIdentity, EMPTY_SERVICE_IDENTITY_SIGNALS } from "@maple/domain/service-identity"

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
const mapWithIdentity = ServiceMap.init(
	buildSourceGraph({
		edges: bench.edges,
		dbEdges: bench.dbEdges,
		serviceOverviews: bench.overviews,
		durationSeconds: DURATION_SECONDS,
		identities: new Map([
			[
				serviceId,
				classifyServiceIdentity({
					...EMPTY_SERVICE_IDENTITY_SIGNALS,
					scopeNames: ["effect"],
					serverSpans: 80,
					classifiedSpans: 100,
				}),
			],
		]),
	}),
	{ minTrafficPct: 0, focus: Option.none() },
).model
const callee = caller?.targetService ?? ""
const dbCaller = bench.dbEdges[0]

type Message = Readonly<{ _tag: "Map"; message: ServiceMap.Message }> | Readonly<{ _tag: "Tabs" }>
type Model = Readonly<{ withInfrastructure: boolean; withIdentity?: boolean }>

const update = (model: Model) => ({ model })
const view = (model: Model, h: HtmlBuilder<Message>, selected = serviceId) =>
	servicePanel<Message>(h, {
		serviceId: selected,
		map: model.withIdentity === true ? mapWithIdentity : map,
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
					tabs: Tabs.init({
						idBase: 60,
						values: ["service", "infrastructure"],
						selected: "service",
					}),
					toTabsMessage: () => ({ _tag: "Tabs" }),
					count: 2,
					content: () => [h.span([], ["the infra tab"])],
				}
			: undefined,
	})

describe("the service map's service panel", () => {
	test("lists the databases the service calls", () => {
		scene(
			{
				update,
				view: (model: Model, h: HtmlBuilder<Message>) =>
					view(model, h, dbCaller?.sourceService ?? ""),
			},
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
			expectView(role("link", { name: "View traces" })).toHaveAttr(
				"href",
				`/traces?service=${serviceId}`,
			),
			expectView(role("link", { name: callee })).toHaveAttr("href", `/services/${callee}`),
			expectView(role("tab", { name: /Infrastructure/ })).not.toExist(),
		)
	})

	test("names the service's kind and framework and the signals behind them", () => {
		scene(
			{ update, view: (model: Model, h: HtmlBuilder<Message>) => view(model, h) },
			given({ withInfrastructure: false, withIdentity: true }),
			expectView(text("Identity")).toExist(),
			expectView(text("API · Effect")).toExist(),
			expectView(text("kind inferred from spans")).toExist(),
			expectView(text("80% Server")).toExist(),
		)
	})

	test("shows no Identity section for a service without one", () => {
		scene(
			{ update, view: (model: Model, h: HtmlBuilder<Message>) => view(model, h) },
			given({ withInfrastructure: false }),
			expectView(text("Identity")).not.toExist(),
		)
	})

	test("with the app's Infrastructure tab, the tab strip carries its count", () => {
		scene(
			{ update, view: (model: Model, h: HtmlBuilder<Message>) => view(model, h) },
			given({ withInfrastructure: true }),
			Mount.resolve(
				Tabs.MeasureTabIndicator,
				Tabs.Message.MeasuredIndicator({
					rect: { left: 0, right: 0, top: 0, bottom: 0, width: 60, height: 32 },
				}),
			),
			expectView(role("tab", { name: /Service/ })).toExist(),
			expectView(role("tab", { name: /Infrastructure\s*2/ })).toExist(),
		)
	})
})
