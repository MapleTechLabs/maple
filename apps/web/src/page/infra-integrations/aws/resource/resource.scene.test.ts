import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { ResolveThemeColors, ThemeMessage } from "../../../../charts/theme-colors"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-23 06:00:00", endTime: "2026-10-23 12:00:00" }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const entered = (kind: string, name: string, search: Model["search"]) => {
	const first = init({ kind, name, search }, context).model
	return pageUpdate(first, Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }))
}

describe("aws resource", () => {
	test("an ECS service reads its own series and the traced services", () => {
		const { commands } = entered("ecs", "payments-api", {
			cluster: "prod",
			region: "us-east-1",
			account: "123456789012",
		})
		const series = commands?.find((command) => command.name === "FetchAwsResourceTimeseries")
		expect(series?.args).toMatchObject({
			input: { kind: "ecs", keys: ["payments-api", "prod", "us-east-1", "123456789012"] },
		})
		expect(commands?.map((command) => command.name)).toContain("FetchAwsResourceTraced")
	})

	test("an instance runs as no traced service, so its page never asks", () => {
		const { commands } = entered("ec2", "i-0abc", { region: "eu-central-1", account: "1" })
		expect(commands?.map((command) => command.name)).toEqual(["FetchAwsResourceTimeseries"])
	})

	test("a hot service says so beside its name", () => {
		const { model } = entered("ecs", "worker-billing", { cluster: "jobs", region: "us-east-1" })
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchTimeseries({
				key: model.timeseries.key ?? "",
				result: Result.succeed([
					{
						bucket: "2026-10-23T11:00:00.000Z",
						metric: "aws.ecs.memory_utilization",
						total: 94,
						samples: 1,
					},
				]),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			themeResolved(),
			expectView(text("CPU or memory above 80%")).toExist(),
			expectView(role("link", { name: /Open in AWS console/ })).toHaveAttr(
				"href",
				"https://us-east-1.console.aws.amazon.com/ecs/v2/clusters/jobs/services/worker-billing/health?region=us-east-1",
			),
		)
	})

	test("a kind Maple does not read asks nothing and says so", () => {
		const { model, commands } = entered("dynamodb", "orders", {})
		expect(commands ?? []).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("Maple does not read this kind of resource")).toExist(),
		)
	})
})
