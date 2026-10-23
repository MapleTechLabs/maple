import { OrgId } from "@maple/domain"
import { AwsMetricStream } from "@maple/domain/aws"
import { Timestamp, type V2AwsConnection, type V2AwsIntegration } from "@maple/domain/http/v2"
import { AwsAccountId, AwsConnectionId } from "@maple/domain/primitives"
import { Option, Result, Schema } from "effect"
import { fromString } from "foldkit/url"
import { expect as expectView, given, role, scene, selector, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { AppRoute, hrefOf, urlToAppRoute } from "../../../../route"
import type { PageContext } from "../../../contract"
import type { FleetRead } from "../data"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-23 06:00:00", endTime: "2026-10-23 12:00:00" }
const NOW = 1_792_000_000_000

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const steps = (model: Model, messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => pageUpdate(current, message).model, model)

const stream = Schema.decodeSync(AwsMetricStream)({ regions: ["us-east-1"], namespaces: ["AWS/ECS"] })

const connection = (metricStream: V2AwsConnection["metric_stream"]): V2AwsConnection => ({
	id: Schema.decodeSync(AwsConnectionId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"),
	object: "aws_connection",
	account_id: Schema.decodeSync(AwsAccountId)("123456789012"),
	role_arn: "arn:aws:iam::123456789012:role/MapleIntegration-018f2b3c4d5e4f708192a3b4",
	oidc_issuer: "https://api.maple.dev/oidc/aws",
	oidc_subject: "aws-connection:018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8",
	modules: [],
	granted_modules: [],
	template_version: 2,
	setup_outdated: false,
	verified_at: Schema.decodeSync(Timestamp)("2026-10-23T10:00:00.000Z"),
	last_checked_at: null,
	last_check_error: null,
	metric_stream: metricStream,
	metric_stream_changed_at: null,
	metrics_last_received_at: null,
	metrics_last_error: null,
	created_at: Schema.decodeSync(Timestamp)("2026-10-23T10:00:00.000Z"),
})

const status = (connections: ReadonlyArray<V2AwsConnection>): V2AwsIntegration => ({
	object: "aws_integration",
	available: true,
	modules: [],
	connections,
})

const cpu = (name: string, percent: number) => ({
	keys: [name, "prod", "us-east-1", "123456789012"],
	metric: "aws.ecs.cpu_utilization",
	total: percent,
	samples: 1,
	peak: percent,
	lastSeen: "2026-10-23T12:00:00.000Z",
})

const loaded = (
	search: Model["search"],
	connections: ReadonlyArray<V2AwsConnection>,
	fleet: ReadonlyArray<FleetRead>,
	range = window,
) => {
	const entered = init({ search }, context).model
	const windowed = steps(entered, [
		Message.CompletedResolveWindow({ window: range, nowMs: NOW, mode: "Load" }),
	])
	return pageUpdate(
		steps(windowed, [
			Message.CompletedLoadStatus({
				key: windowed.status.key ?? "",
				result: Result.succeed(status(connections)),
			}),
		]),
		Message.CompletedFetchFleet({ key: windowed.fleet.key ?? "", result: Result.succeed(fleet) }),
	)
}

describe("aws resource links", () => {
	test("a resource's URL reads back as its kind, name and keys", () => {
		const href = hrefOf(
			AppRoute.InfraAwsResource({
				kind: "loadBalancers",
				name: "app/prod-alb/50dc6c495c0c9188",
				search: { region: "us-east-1", account: "123456789012" },
			}),
		)
		expect(urlToAppRoute(Option.getOrThrow(fromString(`https://app.maple.dev${href}`)))).toMatchObject({
			_tag: "InfraAwsResource",
			kind: "loadBalancers",
			name: "app/prod-alb/50dc6c495c0c9188",
			search: { region: "us-east-1", account: "123456789012" },
		})
	})
	test("a load balancer's slashed name still routes after the edge decodes %2F", () => {
		const url =
			"https://app.maple.dev/infra/aws/loadBalancers/app/prod-alb/50dc6c495c0c9188?region=%22us-east-1%22"
		expect(urlToAppRoute(Option.getOrThrow(fromString(url)))).toMatchObject({
			_tag: "InfraAwsResource",
			kind: "loadBalancers",
			name: "app/prod-alb/50dc6c495c0c9188",
		})
	})
})

describe("aws list", () => {
	test("an account without a metric stream says metrics are off, not that it is healthy", () => {
		const { model } = loaded({}, [connection(null)], [])
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Metrics are off")).toExist(),
			expectView(role("link", { name: "Stream metrics" })).toExist(),
		)
	})

	test("a stream that has sent nothing yet waits, and names its regions", () => {
		const { model } = loaded({}, [connection(stream)], [])
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Waiting for the first metrics")).toExist(),
			expectView(text(/us-east-1 once the stack is deployed again/)).toExist(),
		)
	})

	test("no connection is the connect on-ramp", () => {
		const { model } = loaded({}, [], [])
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("link", { name: "Connect AWS" })).toExist(),
		)
	})

	test("metrics that arrive show even without a connection in Maple", () => {
		const fleet: ReadonlyArray<FleetRead> = [
			{ kind: "ecs", failed: false, points: [cpu("payments-api", 40)] },
		]
		const { model } = loaded({}, [], fleet)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("link", { name: /payments-api/ })).toExist(),
			expectView(text("Connect an AWS account")).toBeAbsent(),
		)
	})

	test("the first reporting kind shows, with its sparklines read once the fleet names it", () => {
		const fleet: ReadonlyArray<FleetRead> = [
			{ kind: "ecs", failed: false, points: [cpu("payments-api", 40), cpu("worker-billing", 92)] },
		]
		const answered = loaded({}, [connection(stream)], fleet)
		expect(names(answered.commands)).toEqual(["FetchAwsSparklines"])
		scene(
			{ update: pageUpdate, view },
			given(answered.model),
			expectView(role("link", { name: /payments-api/ })).toExist(),
			expectView(text(/CPU or memory above 80%/)).toExist(),
		)
	})

	test("an hour's sparkline joins points read 5 minutes apart into one line", () => {
		const hour = { startTime: "2026-10-23 11:00:00", endTime: "2026-10-23 12:00:00" }
		const fleet: ReadonlyArray<FleetRead> = [
			{ kind: "ecs", failed: false, points: [cpu("payments-api", 40)] },
		]
		const { model } = loaded({}, [connection(stream)], fleet, hour)
		const points = Array.from({ length: 12 }, (_, index) => ({
			keys: ["payments-api", "prod", "us-east-1", "123456789012"],
			bucket: new Date(Date.parse("2026-10-23T11:00:00Z") + index * 300_000).toISOString(),
			metric: "aws.ecs.cpu_utilization",
			total: 40,
			samples: 1,
		}))
		const drawn = pageUpdate(
			model,
			Message.CompletedFetchSparks({
				key: model.sparks.key ?? "",
				result: Result.succeed([{ kind: "ecs", points }]),
			}),
		).model
		// A flat line sits mid-height; a broken one would draw each point as a lone dot (`h0.01`).
		scene(
			{ update: pageUpdate, view },
			given(drawn),
			expectView(selector('path[d^="M0 14 L"]')).toExist(),
		)
	})

	test("a band cell filters the table to its resources", () => {
		const fleet: ReadonlyArray<FleetRead> = [
			{ kind: "ecs", failed: false, points: [cpu("payments-api", 40), cpu("worker-billing", 92)] },
		]
		const { model } = loaded({ scope: "hot" }, [connection(stream)], fleet)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("worker-billing")).toExist(),
			expectView(text("payments-api")).toBeAbsent(),
		)
		expect(pageUpdate(model, Message.ClickedScope({ scope: undefined })).outMessage).toMatchObject({
			url: "/infra/aws",
		})
	})
})
