import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { ResolveThemeColors, ThemeMessage } from "../../../../charts/theme-colors"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../../data/load-failure"
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

	test("a load balancer and a queue open on themselves in the AWS console", () => {
		const balancer = entered("loadBalancers", "app/prod-alb/50dc6c495c0c9188", {
			region: "us-east-1",
			account: "123456789012",
		}).model
		scene(
			{ update: pageUpdate, view },
			given(balancer),
			themeResolved(),
			expectView(role("link", { name: /Open in AWS console/ })).toHaveAttr(
				"href",
				"https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#LoadBalancer:loadBalancerArn=arn%3Aaws%3Aelasticloadbalancing%3Aus-east-1%3A123456789012%3Aloadbalancer%2Fapp%2Fprod-alb%2F50dc6c495c0c9188",
			),
		)
		const queue = entered("sqs", "orders", { region: "eu-central-1", account: "123456789012" }).model
		scene(
			{ update: pageUpdate, view },
			given(queue),
			themeResolved(),
			expectView(role("link", { name: /Open in AWS console/ })).toHaveAttr(
				"href",
				"https://eu-central-1.console.aws.amazon.com/sqs/v3/home?region=eu-central-1#/queues/https%3A%2F%2Fsqs.eu-central-1.amazonaws.com%2F123456789012%2Forders",
			),
		)
	})

	test("a region that is not an AWS region gets no console link", () => {
		const { model } = entered("sqs", "orders", { region: "evil.example/#", account: "123456789012" })
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(role("link", { name: /Open in AWS console/ })).toBeAbsent(),
		)
	})

	test("a failed traced read says so instead of loading forever", () => {
		const { model } = entered("lambda", "notifications-sender", { region: "us-east-1", account: "1" })
		const series = pageUpdate(
			model,
			Message.CompletedFetchTimeseries({
				key: model.timeseries.key ?? "",
				result: Result.succeed([
					{
						bucket: "2026-10-23T11:00:00.000Z",
						metric: "aws.lambda.invocations.sum",
						total: 10,
						samples: 1,
					},
				]),
			}),
		).model
		const failed = pageUpdate(
			series,
			Message.CompletedFetchTraced({
				key: model.traced.key ?? "",
				result: Result.fail(toLoadFailure(new Error("boom"))),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themeResolved(),
			expectView(text("Couldn't load the traced service")).toExist(),
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
