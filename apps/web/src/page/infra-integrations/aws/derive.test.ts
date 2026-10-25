import { describe, expect, test } from "vitest"
import type { FleetRead } from "./data"
import { filterViews, keysOf, resourceSearch, resourceViews, summaryOf } from "./derive"

const point = (
	keys: ReadonlyArray<string>,
	metric: string,
	total: number,
	samples: number,
	peak = total,
) => ({
	keys,
	metric,
	total,
	samples,
	peak,
	lastSeen: "2026-10-23T12:00:00.000Z",
})

const ecs = (points: FleetRead["points"]): FleetRead => ({ kind: "ecs", points, failed: false })

describe("resourceViews", () => {
	test("reads a gauge as its mean and names a service by its first key", () => {
		const [view] = resourceViews(
			ecs([
				point(["payments-api", "prod", "us-east-1", "123"], "aws.ecs.cpu_utilization", 120, 4, 70),
				point(["payments-api", "prod", "us-east-1", "123"], "aws.ecs.memory_utilization", 200, 4, 55),
			]),
		)
		expect(view).toMatchObject({
			name: "payments-api",
			cluster: "prod",
			region: "us-east-1",
			account: "123",
			readings: { cpu: { value: 30, peak: 70 }, memory: { value: 50, peak: 55 } },
			health: "ok",
		})
	})

	test("puts a hot service and an idle one before a healthy one", () => {
		const views = resourceViews(
			ecs([
				point(["a-healthy", "prod", "us-east-1", "1"], "aws.ecs.cpu_utilization", 40, 1),
				point(["b-hot", "prod", "us-east-1", "1"], "aws.ecs.memory_utilization", 94, 1),
				point(["c-idle", "prod", "us-east-1", "1"], "aws.ecs.cpu_utilization", 1, 1),
			]),
		)
		expect(views.map((view) => [view.name, view.health, view.scope])).toEqual([
			["b-hot", "warn", "hot"],
			["c-idle", "idle", "idle"],
			["a-healthy", "ok", null],
		])
		expect(summaryOf(views)).toMatchObject({
			total: 3,
			healthy: 1,
			needsLook: 2,
			byScope: { hot: 1, idle: 1 },
		})
	})

	test("flags a load balancer whose targets and itself serve 1% 5xx", () => {
		const keys = ["app/prod-alb/abc", "us-east-1", "1"]
		const [view] = resourceViews({
			kind: "loadBalancers",
			failed: false,
			points: [
				point(keys, "aws.application_elb.request_count.sum", 1000, 60),
				point(keys, "aws.application_elb.http_code_target_5xx_count.sum", 6, 60),
				point(keys, "aws.application_elb.http_code_elb_5xx_count.sum", 4, 60),
			],
		})
		expect(view).toMatchObject({ health: "crit", scope: "5xx", readings: { requests: { value: 1000 } } })
	})

	test("calls a queue backed up by its oldest message's peak, not its mean", () => {
		const [view] = resourceViews({
			kind: "sqs",
			failed: false,
			points: [
				point(["orders", "us-east-1", "1"], "aws.sqs.approximate_age_of_oldest_message", 60, 6, 900),
			],
		})
		expect(view?.scope).toBe("backlog")
	})
})

describe("filterViews", () => {
	const views = resourceViews(
		ecs([
			point(["payments-api", "prod", "us-east-1", "1"], "aws.ecs.cpu_utilization", 40, 1),
			point(["billing-worker", "jobs", "eu-central-1", "1"], "aws.ecs.cpu_utilization", 90, 1),
		]),
	)

	test("matches the name or cluster, the region, and the band scope", () => {
		expect(filterViews(views, { q: "JOBS" }).map((view) => view.name)).toEqual(["billing-worker"])
		expect(filterViews(views, { region: "us-east-1" }).map((view) => view.name)).toEqual(["payments-api"])
		expect(filterViews(views, { scope: "hot" }).map((view) => view.name)).toEqual(["billing-worker"])
	})
})

describe("resource links", () => {
	test("an ECS service's page reads back the keys its row was read with", () => {
		const [view] = resourceViews(
			ecs([point(["svc", "prod", "us-east-1", "123"], "aws.ecs.cpu_utilization", 1, 1)]),
		)
		const keys = view === undefined ? [] : keysOf("ecs", view.name, resourceSearch(view))
		expect(keys).toEqual(["svc", "prod", "us-east-1", "123"])
	})

	test("an instance has no cluster key", () => {
		expect(keysOf("ec2", "i-0abc", { region: "eu-central-1", account: "1", cluster: "x" })).toEqual([
			"i-0abc",
			"eu-central-1",
			"1",
		])
	})
})
