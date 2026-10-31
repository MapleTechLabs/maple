import { AWS_INFRA_KINDS, type AwsInfraKindId } from "@maple/domain/aws-infra"
import type { Tone } from "@maple/ui/lib/tone"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { Array as Arr } from "effect"
import type { TracedService } from "../kit/traced"
import type { FleetRead, SparkRead } from "./data"

// What the AWS pages read off the metric rows: one view per resource, its health, and the summary.

/** A metric over the window: a gauge's mean and highest point, or a sum's total. */
export type Reading = Readonly<{ value: number; peak: number }>

export type Health = "crit" | "warn" | "idle" | "ok"

export const HEALTH_TONE = {
	crit: "crit",
	warn: "warn",
	idle: "neutral",
	ok: "ok",
} as const satisfies Record<Health, Tone>

export type ResourceView = Readonly<{
	kind: AwsInfraKindId
	keys: ReadonlyArray<string>
	/** The first identity value: what the row and its page are called. */
	name: string
	/** The ECS cluster; empty for every other kind. */
	cluster: string
	region: string
	account: string
	readings: Readonly<Record<string, Reading>>
	lastSeenMs: number
	health: Health
	/** Why it needs a look, or null when healthy. */
	reason: string | null
	/** The band cell it counts in, or null. */
	scope: string | null
}>

/** A CloudWatch percent as a share of 1. */
const share = (percent: number) => percent / 100

export const HOT = 0.8
export const IDLE = 0.03
export const ERROR_RATE = 0.01
/** Five minutes, in seconds: an SQS queue's oldest message older than this is backed up. */
export const BACKED_UP_SECONDS = 300

const valueOf = (readings: ResourceView["readings"], key: string) => readings[key]?.value ?? null

/** Requests, invocations and other sums per minute over the window. */
export const perMinute = (total: number, windowMs: number) =>
	windowMs <= 0 ? 0 : total / (windowMs / 60_000)

/** A load balancer's 5xx share: the targets' and its own, of its requests. */
export const lb5xxRate = (readings: ResourceView["readings"]) => {
	const requests = valueOf(readings, "requests") ?? 0
	if (requests <= 0) return null
	return ((valueOf(readings, "target5xx") ?? 0) + (valueOf(readings, "elb5xx") ?? 0)) / requests
}

export const lambdaErrorRate = (readings: ResourceView["readings"]) => {
	const invocations = valueOf(readings, "invocations") ?? 0
	return invocations <= 0 ? null : (valueOf(readings, "errors") ?? 0) / invocations
}

/** CPU and memory as shares of 1, null when the resource sends none. */
export const cpuShare = (view: Pick<ResourceView, "readings">) => {
	const cpu = valueOf(view.readings, "cpu")
	return cpu === null ? null : share(cpu)
}

export const memoryShare = (view: Pick<ResourceView, "readings">) => {
	const memory = valueOf(view.readings, "memory")
	return memory === null ? null : share(memory)
}

export type Judgement = Readonly<{ health: Health; reason: string | null; scope: string | null }>

const OK: Judgement = { health: "ok", reason: null, scope: null }

/** The worst thing about a resource first: an error before saturation before idleness. */
export const judge = (kind: AwsInfraKindId, readings: ResourceView["readings"]): Judgement => {
	const cpu = cpuShare({ readings })
	const memory = memoryShare({ readings })
	const hot =
		(cpu !== null && cpu >= HOT) || (memory !== null && memory >= HOT)
			? { health: "warn" as const, reason: "CPU or memory above 80%", scope: "hot" }
			: null
	const idle =
		cpu !== null && cpu < IDLE && (memory === null || memory < IDLE * 10)
			? { health: "idle" as const, reason: "CPU under 3% for the window", scope: "idle" }
			: null
	switch (kind) {
		case "ecs":
		case "rds":
			return hot ?? idle ?? OK
		case "ec2": {
			const failed = valueOf(readings, "statusFailed") ?? 0
			if (failed > 0) return { health: "crit", reason: "Status check failing", scope: "status" }
			return hot ?? idle ?? OK
		}
		case "loadBalancers": {
			const rate = lb5xxRate(readings)
			return rate !== null && rate >= ERROR_RATE
				? { health: "crit", reason: "5xx at 1% of requests or more", scope: "5xx" }
				: OK
		}
		case "lambda": {
			const rate = lambdaErrorRate(readings)
			if (rate !== null && rate >= ERROR_RATE)
				return { health: "crit", reason: "Errors at 1% of invocations or more", scope: "errors" }
			return (valueOf(readings, "throttles") ?? 0) > 0
				? { health: "warn", reason: "Throttled", scope: "throttled" }
				: OK
		}
		case "sqs": {
			const age = readings["oldestAge"]?.peak ?? 0
			return age >= BACKED_UP_SECONDS
				? { health: "warn", reason: "Oldest message waited over 5 min", scope: "backlog" }
				: OK
		}
	}
}

const HEALTH_ORDER = { crit: 0, warn: 1, idle: 2, ok: 3 } satisfies Record<Health, number>

/** One kind's resources, problems first, then by name. */
export const resourceViews = (read: FleetRead): ReadonlyArray<ResourceView> => {
	const definition = AWS_INFRA_KINDS[read.kind]
	const byName = new Map(definition.metrics.map((metric) => [metric.name, metric]))
	const identity = definition.identity.length
	const grouped = Arr.groupBy(read.points, (point) => JSON.stringify(point.keys))
	return Object.values(grouped)
		.flatMap((points) => {
			const first = points[0]
			if (first === undefined) return []
			const readings = Object.fromEntries(
				points.flatMap((point) => {
					const metric = byName.get(point.metric)
					if (metric === undefined) return []
					const value =
						metric.table === "sum"
							? point.total
							: point.samples > 0
								? point.total / point.samples
								: 0
					return [[metric.key, { value, peak: point.peak }] as const]
				}),
			)
			const keys = first.keys
			return [
				{
					kind: read.kind,
					keys,
					name: keys[0] ?? "",
					cluster: read.kind === "ecs" ? (keys[1] ?? "") : "",
					region: keys[identity] ?? "",
					account: keys[identity + 1] ?? "",
					readings,
					lastSeenMs: Math.max(...points.map((point) => toEpochMs(point.lastSeen))),
					...judge(read.kind, readings),
				},
			]
		})
		.toSorted((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.name.localeCompare(b.name))
}

export type BandCell = Readonly<{ scope: string; label: string; hint: string; tone: Health }>

/** The callouts a kind's band shows, in order. */
export const BAND_CELLS = {
	ecs: [
		{ scope: "hot", label: "Hot", hint: "CPU or memory above 80%", tone: "warn" },
		{ scope: "idle", label: "Idle, still billed", hint: "CPU under 3% for the window", tone: "idle" },
	],
	ec2: [
		{ scope: "status", label: "Status check failing", hint: "Instance or system check", tone: "crit" },
		{ scope: "hot", label: "Hot", hint: "CPU above 80%", tone: "warn" },
		{ scope: "idle", label: "Idle, still billed", hint: "CPU under 3% for the window", tone: "idle" },
	],
	loadBalancers: [{ scope: "5xx", label: "Serving 5xx", hint: "1% of requests or more", tone: "crit" }],
	rds: [
		{ scope: "hot", label: "Hot", hint: "CPU above 80%", tone: "warn" },
		{ scope: "idle", label: "Idle, still billed", hint: "CPU under 3% for the window", tone: "idle" },
	],
	lambda: [
		{ scope: "errors", label: "Erroring", hint: "1% of invocations or more", tone: "crit" },
		{ scope: "throttled", label: "Throttled", hint: "Any throttle in the window", tone: "warn" },
	],
	sqs: [{ scope: "backlog", label: "Backed up", hint: "Oldest message over 5 min", tone: "warn" }],
} satisfies Record<AwsInfraKindId, ReadonlyArray<BandCell>>

export type Summary = Readonly<{
	total: number
	healthy: number
	needsLook: number
	counts: Readonly<Record<Health, number>>
	byScope: Readonly<Record<string, number>>
}>

export const summaryOf = (views: ReadonlyArray<ResourceView>): Summary => {
	const counts = views.reduce<Record<Health, number>>(
		(acc, view) => ({ ...acc, [view.health]: acc[view.health] + 1 }),
		{ crit: 0, warn: 0, idle: 0, ok: 0 },
	)
	const byScope = views.reduce<Record<string, number>>(
		(acc, view) => (view.scope === null ? acc : { ...acc, [view.scope]: (acc[view.scope] ?? 0) + 1 }),
		{},
	)
	return { total: views.length, healthy: counts.ok, needsLook: views.length - counts.ok, counts, byScope }
}

export type Filters = Readonly<{ q?: string; region?: string; scope?: string }>

export const filterViews = (views: ReadonlyArray<ResourceView>, filters: Filters) => {
	const q = filters.q?.trim().toLowerCase() ?? ""
	return views.filter(
		(view) =>
			(q === "" || view.name.toLowerCase().includes(q) || view.cluster.toLowerCase().includes(q)) &&
			(filters.region === undefined || view.region === filters.region) &&
			(filters.scope === undefined || view.scope === filters.scope),
	)
}

export const regionsOf = (views: ReadonlyArray<ResourceView>) =>
	[...new Set(views.map((view) => view.region).filter((region) => region !== ""))].toSorted()

/** A row's sparkline: its metric's mean per bucket for a gauge, its sum for a counter. */
type SparkPoint = { readonly bucket: string; readonly value: number | null }

const sparkId = (kind: AwsInfraKindId, keys: ReadonlyArray<string>) => `${kind}:${JSON.stringify(keys)}`

/** Every row's sparkline points, read once per render and looked up by `sparkPoints`. */
export type SparkIndex = ReadonlyMap<string, ReadonlyArray<SparkPoint>>

export const sparkIndex = (sparks: ReadonlyArray<SparkRead>): SparkIndex =>
	new Map(
		sparks.flatMap((read) => {
			const definition = AWS_INFRA_KINDS[read.kind]
			const metric = definition.metrics.find((entry) => entry.key === definition.sparkline)
			if (metric === undefined) return []
			const points = read.points.filter((point) => point.metric === metric.name)
			return Object.entries(Arr.groupBy(points, (point) => sparkId(read.kind, point.keys))).map(
				([id, group]) =>
					[
						id,
						group.map((point): SparkPoint => ({
							bucket: point.bucket,
							value:
								metric.table === "sum"
									? point.total
									: point.samples > 0
										? point.total / point.samples
										: null,
						})),
					] as const,
			)
		}),
	)

export const sparkPoints = (index: SparkIndex, view: ResourceView) =>
	index.get(sparkId(view.kind, view.keys)) ?? []

/** The traced service an ECS service or Lambda function runs as: the same name, case aside. */
export const tracedAs = (traced: ReadonlyArray<TracedService>, view: Pick<ResourceView, "kind" | "name">) => {
	if (view.kind !== "ecs" && view.kind !== "lambda") return null
	const name = view.name.toLowerCase()
	return traced.find((service) => service.serviceName.toLowerCase() === name) ?? null
}

/** The search a resource's page reads its keys back from. */
export const resourceSearch = (view: Pick<ResourceView, "kind" | "cluster" | "region" | "account">) => ({
	cluster: view.kind === "ecs" && view.cluster !== "" ? view.cluster : undefined,
	region: view.region === "" ? undefined : view.region,
	account: view.account === "" ? undefined : view.account,
})

/** `resourceSearch` read back into the keys the queries take. */
export const keysOf = (
	kind: AwsInfraKindId,
	name: string,
	search: Readonly<{ cluster?: string; region?: string; account?: string }>,
): ReadonlyArray<string> => [
	name,
	...(kind === "ecs" ? [search.cluster ?? ""] : []),
	search.region ?? "",
	search.account ?? "",
]
