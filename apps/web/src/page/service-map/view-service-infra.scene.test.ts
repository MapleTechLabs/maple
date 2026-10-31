import { ServiceName } from "@maple/domain/http"
import { Schema } from "effect"
import { expect as expectView, given, role, scene, text } from "foldkit/scene"
import type { HtmlBuilder } from "foldkit/html"
import { describe, test } from "vitest"
import type { ServiceRuntime } from "../kit/service-runtimes"
import { serviceMapNode } from "../../service-map/map/nodes"
import type { Message } from "./message"
import { infrastructureTab } from "./view-service-infra"

// The service panel's Infrastructure tab and the node card, rendered on their own: the page scene
// cannot reach them without the canvas's measure and layout mounts.

type Model = Readonly<{ runtimes: ReadonlyArray<ServiceRuntime> }>

const CLOUD_RUN: ServiceRuntime = {
	serviceName: Schema.decodeSync(ServiceName)("payments"),
	kind: "cloudRun",
	account: "acme-prod",
	region: "europe-west1",
	cluster: "",
	railwayServiceId: "",
	railwayEnvironmentId: "",
	railwayEnvironmentName: "",
}

const update = (model: Model) => ({ model })
const tabView = (model: Model, h: HtmlBuilder<Message>) =>
	h.div([], infrastructureTab(h, [], model.runtimes, { timePreset: "1h" }))

describe("the service panel's Infrastructure tab", () => {
	test("links the Cloud Run service the selected service runs as", () => {
		scene(
			{ update, view: tabView },
			given({ runtimes: [CLOUD_RUN] }),
			expectView(text("Runs on")).toExist(),
			expectView(role("link", { name: /payments/ })).toHaveAttr(
				"href",
				"/infra/gcp/cloudRun/payments?project=acme-prod&region=europe-west1&timePreset=1h",
			),
			expectView(text("acme-prod · europe-west1")).toExist(),
			expectView(text("Not linked to any infrastructure")).not.toExist(),
		)
	})

	test("with no platform and no cluster, explains how either gets linked", () => {
		scene(
			{ update, view: tabView },
			given({ runtimes: [] }),
			expectView(text("Not linked to any infrastructure")).toExist(),
			expectView(text("Runs on")).not.toExist(),
		)
	})
})

describe("the map's service node", () => {
	const node = (runsOn: string | undefined) => (_model: Model, h: HtmlBuilder<Message>) =>
		serviceMapNode(h, "payments", {
			label: "payments",
			kind: "service",
			throughput: 1,
			tracedThroughput: 1,
			hasSampling: false,
			samplingWeight: 1,
			errorRate: 0,
			avgLatencyMs: 10,
			selected: false,
			runsOn,
		})

	test("drops the empty pods cell when it runs on a platform", () => {
		scene({ update, view: node("Cloud Run") }, given({ runtimes: [] }), expectView(text("pods")).not.toExist())
	})

	test("keeps the pods cell when it runs on no platform", () => {
		scene({ update, view: node(undefined) }, given({ runtimes: [] }), expectView(text("pods")).toExist())
	})
})
