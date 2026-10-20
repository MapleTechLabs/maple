import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import * as Frame from "../../kit/frame"
import { Message } from "./message"
import type { Model, NodeRow } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const node = (nodeName: string, lastSeen = "2026-10-01 12:00:00"): NodeRow => ({
	nodeName,
	nodeUid: "uid",
	clusterName: "prod",
	environment: "production",
	kubeletVersion: "v1.31.0",
	lastSeen,
	cpuUsage: 1,
	cpuAllocatable: 4,
	cpuUtilization: 0.25,
	memoryUsage: 1e9,
	memoryAllocatable: 8e9,
	memoryUtilization: 0.125,
	uptime: 3600,
})

const loaded = (nodes: ReadonlyArray<NodeRow>, search: Model["search"] = {}) => {
	const model = pageUpdate(
		init({ search }, context).model,
		Message.GotFrameMessage({ message: Frame.Message.CompletedResolveWindow({ window, nowMs: NOW, locale: "en-US", mode: "Load" }) }),
	).model
	return pageUpdate(model, Message.CompletedFetchNodes({ key: model.nodes.key ?? "", result: Result.succeed(nodes) })).model
}

describe("nodes list", () => {
	test("the status scope and the search narrow the loaded fleet in the browser", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([node("live-1"), node("gone-1", "2026-10-01 09:00:00")], { status: "ended" })),
			expectView(text("gone-1")).toExist(),
			expectView(text("live-1")).not.toExist(),
		)
	})

	test("a facet tick writes the node to the URL", () => {
		const ticked = pageUpdate(loaded([node("live-1")]), Message.ToggledFacetOption({ facet: "nodeNames", name: "live-1" }))
		expect(ticked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/infra/kubernetes/nodes?nodeNames=%5B%22live-1%22%5D",
				isReplace: false,
			}),
		)
	})
})
