import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import * as Frame from "../../kit/frame"
import type { PodRow } from "../pod-data"
import { Message } from "./message"
import type { Model } from "./model"
import { init, podsInput, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)

const pod = (podName: string): PodRow => ({
	podName,
	namespace: "shop",
	nodeName: "ip-10-0-12-84",
	clusterName: "prod",
	environment: "production",
	deploymentName: "payment-svc",
	statefulsetName: "",
	daemonsetName: "",
	jobName: "",
	qosClass: "Burstable",
	podUid: "uid",
	computeType: "ec2",
	lastSeen: "2026-10-01 12:00:00",
	cpuUsage: 0.4,
	cpuLimitPct: 0.5,
	memoryLimitPct: 0.9,
	cpuRequestPct: 0.6,
	memoryRequestPct: 0.95,
	cpuUsagePeak: 0.5,
	cpuLimitPctPeak: 0.55,
	memoryLimitPctPeak: 0.98,
	saturation: 0.98,
})

const windowed = (search: Model["search"] = {}) =>
	pageUpdate(
		init({ search }, context).model,
		Message.GotFrameMessage({ message: Frame.Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }) }),
	)

describe("pods list", () => {
	test("the Ended scope swaps the lifecycle; the other scopes narrow the live fleet", () => {
		expect(podsInput(windowed({ scope: "ended" }).model, window)).toMatchObject({ scope: undefined, lifecycle: "ended" })
		expect(podsInput(windowed({ scope: "saturated" }).model, window)).toMatchObject({
			scope: "saturated",
			lifecycle: "live",
		})
	})

	test("a loaded page asks for its pods' restarts", () => {
		const model = windowed().model
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchPods({
				key: model.pods.key ?? "",
				result: Result.succeed({ data: [pod("payment-1")], totalCount: 1 }),
			}),
		)
		expect((loaded.commands ?? []).map(({ name }) => name)).toEqual(["FetchInfraPodRestarts"])
	})

	test("a plain row click peeks: the row's key goes to the URL", () => {
		const peeked = pageUpdate(windowed().model, Message.ClickedPeekRow({ key: "shop/payment-1" }))
		expect(peeked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/infra/kubernetes/pods?peek=shop%2Fpayment-1",
				isReplace: false,
			}),
		)
	})
})
