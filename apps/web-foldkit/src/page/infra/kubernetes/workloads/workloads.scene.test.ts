import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import * as Frame from "../../kit/frame"
import * as WorkloadDetail from "../workload/update"
import { Message as DetailMessage } from "../workload/message"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const resolved = Frame.Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" })

describe("workloads", () => {
	test("the kind pivot writes the kind and drops a name filter of the old kind", () => {
		const model = pageUpdate(init({ search: { workloadNames: ["payment-svc"] } }, context).model, Message.GotFrameMessage({ message: resolved })).model
		expect(pageUpdate(model, Message.ChangedKind({ kind: "job" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/kubernetes/workloads?kind=job", isReplace: false }),
		)
	})

	test("a header sorts, flips, then hands the order back to the server", () => {
		const model = init({ search: {} }, context).model
		const once = pageUpdate(model, Message.ClickedSort({ key: "podCount" })).model
		const twice = pageUpdate(once, Message.ClickedSort({ key: "podCount" })).model
		const thrice = pageUpdate(twice, Message.ClickedSort({ key: "podCount" })).model
		expect([once.sort, twice.sort, thrice.sort.key]).toEqual([
			{ key: "podCount", dir: "desc" },
			{ key: "podCount", dir: "asc" },
			null,
		])
	})

	test("the workload page asks for the aggregate series once the breakdown is unticked", () => {
		const route = { kind: "deployment" as const, workloadName: "payment-svc", search: { namespace: "shop" } }
		const entered = WorkloadDetail.init(route, context).model
		const windowed = WorkloadDetail.update(entered, DetailMessage.GotFrameMessage({ message: resolved }), context).model
		const aggregate = WorkloadDetail.update(windowed, DetailMessage.ToggledGroupByPod({ isChecked: false }), context)
		expect((aggregate.commands ?? []).map(({ name }) => name)).toEqual(["FetchInfraWorkloadSeries"])
	})
})
