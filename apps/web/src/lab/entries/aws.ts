import { OrgId } from "@maple/domain"
import { AwsMetricStream } from "@maple/domain/aws"
import { Timestamp, type V2AwsConnection, type V2AwsIntegration } from "@maple/domain/http/v2"
import { AwsAccountId, AwsConnectionId } from "@maple/domain/primitives"
import { Effect, Option, Result, Schema } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { fromString as urlFromString } from "foldkit/url"
import { chartBucketSeconds } from "../../charts/infra-metric-series"
import type { PageContext, PageReturn } from "../../page/contract"
import type { FleetRead, SparkRead } from "../../page/infra-integrations/aws/data"
import { Message as PageMessage } from "../../page/infra-integrations/aws/list/message"
import { Model as PageModel } from "../../page/infra-integrations/aws/list/model"
import * as AwsUpdate from "../../page/infra-integrations/aws/list/update"
import { view as pageView } from "../../page/infra-integrations/aws/list/view"
import type { Resources } from "../../platform/resources"
import { urlToAppRoute } from "../../route"
import { defineShellLab } from "../shell-lab"

// `/lab/aws[?tab=ec2]`: the AWS infra list over one account's ECS services, EC2 instances and
// load balancers, in the real shell. Reads are answered with fixtures, nothing leaves the tab.

const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_aws"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const ACCOUNT = "465760687006"
const REGION = "us-east-1"
const WINDOW = { startTime: "2026-10-24 06:00:00", endTime: "2026-10-24 12:00:00" }
const WINDOW_START_MS = 1_792_821_600_000 // 2026-10-24T06:00:00Z
const WINDOW_END_MS = 1_792_843_200_000 // 2026-10-24T12:00:00Z
const LAST_SEEN = "2026-10-24T11:59:00.000Z"

const connection: V2AwsConnection = {
	id: Schema.decodeSync(AwsConnectionId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"),
	object: "aws_connection",
	account_id: Schema.decodeSync(AwsAccountId)(ACCOUNT),
	role_arn: `arn:aws:iam::${ACCOUNT}:role/MapleIntegration-018f2b3c4d5e4f708192a3b4`,
	oidc_issuer: "https://api.maple.dev/oidc/aws",
	oidc_subject: "aws-connection:018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8",
	modules: [],
	granted_modules: [],
	template_version: 2,
	setup_outdated: false,
	verified_at: Schema.decodeSync(Timestamp)("2026-10-20T10:00:00.000Z"),
	last_checked_at: null,
	last_check_error: null,
	metric_stream: Schema.decodeSync(AwsMetricStream)({
		regions: [REGION],
		namespaces: ["AWS/ECS", "AWS/EC2", "AWS/ApplicationELB"],
	}),
	metric_stream_changed_at: null,
	metrics_last_received_at: null,
	metrics_last_error: null,
	created_at: Schema.decodeSync(Timestamp)("2026-10-20T10:00:00.000Z"),
}

const STATUS: V2AwsIntegration = {
	object: "aws_integration",
	available: true,
	modules: [],
	connections: [connection],
}

/** One resource: its identity, then a mean (gauge) or window total (sum) per metric. */
type Resource = Readonly<{ identity: ReadonlyArray<string>; values: Readonly<Record<string, number>> }>

const RESOURCES = {
	ecs: [
		{
			identity: ["maple-electric", "maple-electric"],
			values: { "aws.ecs.cpu_utilization": 1.7, "aws.ecs.memory_utilization": 20 },
		},
		{
			identity: ["maple-otel-collector", "maple-ingest"],
			values: { "aws.ecs.cpu_utilization": 0.8, "aws.ecs.memory_utilization": 8.2 },
		},
		{
			identity: ["maple-ingest-ec2", "maple-ingest"],
			values: { "aws.ecs.cpu_utilization": 20, "aws.ecs.memory_utilization": 5.4 },
		},
		{
			identity: ["maple-scraper", "maple-scraper"],
			values: { "aws.ecs.cpu_utilization": 6, "aws.ecs.memory_utilization": 39 },
		},
	],
	ec2: [
		{
			identity: ["i-0a4f2c9e81b37d150"],
			values: {
				"aws.ec2.cpu_utilization": 18,
				"aws.ec2.network_in.sum": 4.2e9,
				"aws.ec2.network_out.sum": 1.1e9,
				"aws.ec2.status_check_failed": 0,
			},
		},
		{
			identity: ["i-07d1b6e3a92c48f0e"],
			values: {
				"aws.ec2.cpu_utilization": 2.1,
				"aws.ec2.network_in.sum": 3.8e8,
				"aws.ec2.network_out.sum": 2.2e8,
				"aws.ec2.status_check_failed": 0,
			},
		},
	],
	loadBalancers: [
		{
			identity: ["app/maple-ingest-alb/50dc6c495c0c9188"],
			values: {
				"aws.application_elb.request_count.sum": 1_840_000,
				"aws.application_elb.http_code_target_5xx_count.sum": 120,
				"aws.application_elb.http_code_elb_5xx_count.sum": 4,
				"aws.application_elb.target_response_time": 0.042,
			},
		},
		{
			identity: ["app/maple-electric-alb/9a1e07c3b5d24f61"],
			values: {
				"aws.application_elb.request_count.sum": 96_000,
				"aws.application_elb.http_code_target_5xx_count.sum": 0,
				"aws.application_elb.http_code_elb_5xx_count.sum": 0,
				"aws.application_elb.target_response_time": 0.011,
			},
		},
	],
} satisfies Record<"ecs" | "ec2" | "loadBalancers", ReadonlyArray<Resource>>

const SPARK_METRIC = {
	ecs: "aws.ecs.cpu_utilization",
	ec2: "aws.ec2.cpu_utilization",
	loadBalancers: "aws.application_elb.request_count.sum",
} as const

const keysOf = (resource: Resource) => [...resource.identity, REGION, ACCOUNT]

const FLEET: ReadonlyArray<FleetRead> = (["ecs", "ec2", "loadBalancers"] as const).map((kind) => ({
	kind,
	failed: false,
	points: RESOURCES[kind].flatMap((resource) =>
		Object.entries(resource.values).map(([metric, value]) => ({
			keys: keysOf(resource),
			metric,
			total: value,
			samples: 1,
			peak: value,
			lastSeen: LAST_SEEN,
		})),
	),
}))

const BUCKET_SECONDS = chartBucketSeconds(WINDOW.startTime, WINDOW.endTime)
const BUCKET_COUNT = Math.floor((WINDOW_END_MS - WINDOW_START_MS) / (BUCKET_SECONDS * 1000))

/** A wobble around the resource's window figure, so each line has its own shape. */
const sparkFor = (kind: keyof typeof SPARK_METRIC, resource: Resource, seed: number): SparkRead["points"] => {
	const metric = SPARK_METRIC[kind]
	const base = resource.values[metric] ?? 0
	const perBucket = metric.endsWith(".sum") ? base / BUCKET_COUNT : base
	return Array.from({ length: BUCKET_COUNT }, (_, index) => ({
		keys: keysOf(resource),
		bucket: new Date(WINDOW_START_MS + index * BUCKET_SECONDS * 1000).toISOString(),
		metric,
		total: Math.max(
			0,
			perBucket * (1 + 0.35 * Math.sin(index / 3 + seed) + 0.15 * Math.cos(index * 1.7 + seed)),
		),
		samples: 1,
	}))
}

const sparksOf = (kind: FleetRead["kind"]): ReadonlyArray<SparkRead> =>
	kind === "ecs" || kind === "ec2" || kind === "loadBalancers"
		? [
				{
					kind,
					points: RESOURCES[kind].flatMap((resource, index) =>
						sparkFor(kind, resource, index * 2.3),
					),
				},
			]
		: [{ kind, points: [] }]

const Flags = Schema.Struct({ tab: Schema.NullOr(Schema.String) })
type Flags = typeof Flags.Type

const Model = Schema.Struct({ page: PageModel })
type Model = typeof Model.Type

const Message = defineMessageUnion({ GotPageMessage: { message: PageMessage } })
type Message = typeof Message.Type
type Return = Update.Return<Model, Message, Resources>

const isPending = (data: AsyncData.AsyncData<unknown, unknown>) =>
	AsyncData.isLoading(data) || AsyncData.isRefreshing(data)

/** The answers to every read still pending, as the Messages their fetches would have sent. */
const answers = (model: PageModel): ReadonlyArray<PageMessage> => {
	const kind = AwsUpdate.activeKind(model)
	return [
		...(isPending(model.status.data)
			? [
					PageMessage.CompletedLoadStatus({
						key: model.status.key ?? "",
						result: Result.succeed(STATUS),
					}),
				]
			: []),
		...(isPending(model.fleet.data)
			? [PageMessage.CompletedFetchFleet({ key: model.fleet.key ?? "", result: Result.succeed(FLEET) })]
			: []),
		...(isPending(model.traced.data)
			? [PageMessage.CompletedFetchTraced({ key: model.traced.key ?? "", result: Result.succeed([]) })]
			: []),
		...(isPending(model.sparks.data) && kind !== undefined
			? [
					PageMessage.CompletedFetchSparks({
						key: model.sparks.key ?? "",
						result: Result.succeed(sparksOf(kind)),
					}),
				]
			: []),
	]
}

/** Answers pending reads until none is left (an answer can start the next read). */
const settle = (
	result: PageReturn<PageModel, PageMessage>,
	depth = 0,
): PageReturn<PageModel, PageMessage> => {
	const pending = answers(result.model)
	if (pending.length === 0 || depth > 6) return result
	const next = pending.reduce<PageReturn<PageModel, PageMessage>>((acc, message) => {
		const answered = AwsUpdate.update(acc.model, message, CONTEXT)
		return {
			model: answered.model,
			commands: [...(acc.commands ?? []), ...(answered.commands ?? [])],
			outMessage: acc.outMessage ?? answered.outMessage,
		}
	}, result)
	return settle(next, depth + 1)
}

const isRead = (name: string) =>
	/^(ResolveAwsWindow|LoadInfraAwsStatus|FetchAwsFleet|FetchAwsSparklines|FetchAwsTracedServices)$/.test(
		name,
	)

const step = (result: PageReturn<PageModel, PageMessage>): Return => {
	const settled = settle(result)
	return {
		model: { page: settled.model },
		commands: Command.mapMessages(
			(settled.commands ?? []).filter((command) => !isRead(command.name)),
			(message) => Message.GotPageMessage({ message }),
		),
	}
}

/** The page's URL writes (tab, scope, search), applied to its own search like a route change. */
const follow = (model: PageModel, url: string): PageReturn<PageModel, PageMessage> =>
	Option.match(urlFromString(new URL(url, "http://localhost").href), {
		onNone: () => ({ model }),
		onSome: (parsed) => {
			const route = urlToAppRoute(parsed)
			return route._tag === "InfraAws" ? AwsUpdate.routeChanged(model, route, CONTEXT) : { model }
		},
	})

const init = (flags: Flags): Return => {
	const started = AwsUpdate.init({ search: { tab: flags.tab ?? "ecs" } }, CONTEXT)
	const windowed = AwsUpdate.update(
		started.model,
		PageMessage.CompletedResolveWindow({ window: WINDOW, nowMs: WINDOW_END_MS, mode: "Load" }),
		CONTEXT,
	)
	return step({ ...windowed, commands: [...(started.commands ?? []), ...(windowed.commands ?? [])] })
}

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPageMessage: ({ message: inner }) => {
			const next = AwsUpdate.update(model.page, inner, CONTEXT)
			const out = next.outMessage
			if (out === undefined || out._tag !== "RequestedNavigation") return step(next)
			const followed = follow(next.model, out.url)
			return step({ ...followed, commands: [...(next.commands ?? []), ...(followed.commands ?? [])] })
		},
	})

const view = (model: Model, h: HtmlBuilder<Message>) =>
	h.submodel({
		slotId: "aws-lab",
		model: model.page,
		view: pageView,
		viewInputs: { context: CONTEXT },
		toParentMessage: (message: PageMessage) => Message.GotPageMessage({ message }),
	})

export const lab = defineShellLab("AWS", {
	Model,
	Message,
	Flags,
	flags: Effect.sync(() => ({ tab: new URLSearchParams(window.location.search).get("tab") })),
	init,
	update,
	view,
	currentPath: "/lab/aws",
	breadcrumbs: [{ label: "Infrastructure" }, { label: "AWS" }],
})
