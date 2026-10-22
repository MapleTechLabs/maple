import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { Command, expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import * as WorkloadDetail from "../workload/update"
import { Message as DetailMessage } from "../workload/message"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const resolved = Frame.Message.CompletedResolveWindow({ window, nowMs: NOW, locale: "en-US", mode: "Load" })

const NO_INTEGRATIONS = { cloudflare: false, railway: false, planetscale: false, gcp: false, supabase: false }

/** The StatefulSet kind with an empty answer for the window. */
const emptyKind = () => {
	const entered = pageUpdate(
		init({ search: { kind: "statefulset" } }, context).model,
		Message.GotFrameMessage({ message: resolved }),
	)
	return pageUpdate(
		entered.model,
		Message.CompletedFetchWorkloads({
			key: entered.model.workloads.key ?? "",
			result: Result.succeed([]),
		}),
	).model
}

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
	test("an empty kind in a reporting cluster says so, without the install advice", () => {
		const model = emptyKind()
		const reporting: PageContext = {
			...context,
			infra: { presence: ["k8sPods"], isPresenceFailed: false, integrations: NO_INTEGRATIONS },
		}
		scene(
			{ update: pageUpdate, view: withViewInputs(pageView, { context: reporting })() },
			given(model),
			expectView(text("No StatefulSets in this window.")).toExist(),
			expectView(text("No StatefulSets reporting yet")).not.toExist(),
		)
	})

	test("an empty kind waits for the presence probe instead of flashing the install advice", () => {
		const model = emptyKind()
		const probing: PageContext = {
			...context,
			infra: { presence: null, isPresenceFailed: false, integrations: NO_INTEGRATIONS },
		}
		scene(
			{ update: pageUpdate, view: withViewInputs(pageView, { context: probing })() },
			given(model),
			expectView(text("No StatefulSets reporting yet")).not.toExist(),
			expectView(text("No StatefulSets in this window.")).not.toExist(),
		)
		const failed: PageContext = {
			...context,
			infra: { presence: null, isPresenceFailed: true, integrations: NO_INTEGRATIONS },
		}
		scene(
			{ update: pageUpdate, view: withViewInputs(pageView, { context: failed })() },
			given(model),
			Mount.resolve(InstallModal.MountInstallModal, InstallModal.Message.MountedInstallModal()),
			Command.resolve(
				InstallModal.FetchIngestKey,
				InstallModal.Message.CompletedFetchIngestKey({ result: Result.succeed("maple_sk_test") }),
			),
			expectView(text("No StatefulSets reporting yet")).toExist(),
		)
	})
})
