import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	AWS_INFRA_KIND_IDS,
	AWS_INFRA_KINDS,
	AWS_INFRA_RESOURCE_LIMIT,
	AWS_METRIC_PREFIX,
} from "@maple/domain/aws-infra"
import {
	awsInfraBucketCount,
	awsInfraMetricsSQL,
	awsInfraPresenceSQL,
	awsInfraSparklinesSQL,
	awsInfraTimeseriesSQL,
} from "./aws-infra"
import { Array as Arr, String as Str } from "effect"

const params = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-10-23 00:00:00.000",
	endTime: "2026-10-23 12:00:00.000",
}

const metricNames = (sql: string) =>
	Arr.map(Arr.fromIterable(Str.matchAll(/'(aws\.(?!dimension\.)[a-z0-9_.]+)'/g)(sql)), (m) => m[1])

describe("awsInfraMetricsSQL", () => {
	it("reads a load balancer's own series, never its per-target-group or per-zone copies", () => {
		const { sql, tenantScope } = compileUnsafe(awsInfraMetricsSQL("loadBalancers", "raw"), params)
		expect(tenantScope).toBe("single-tenant")
		// CloudWatch repeats RequestCount per target group and zone: those would count twice.
		expect(sql).toContain("metrics_sum.Attributes['aws.dimension.load_balancer'] != ''")
		expect(sql).toContain("metrics_sum.Attributes['aws.dimension.target_group'] = ''")
		expect(sql).toContain("metrics_sum.Attributes['aws.dimension.availability_zone'] = ''")
		expect(sql).toContain("GROUP BY keys, metric")
	})

	it("reads an ECS service's series, not its cluster's", () => {
		const { sql } = compileUnsafe(awsInfraMetricsSQL("ecs", "raw"), params)
		expect(sql).toContain("metrics_gauge.Attributes['aws.dimension.service_name'] != ''")
		expect(sql).toContain("metrics_gauge.Attributes['aws.dimension.cluster_name'] != ''")
	})

	it("reads every kind's sums from metrics_sum and means from metrics_gauge, none twice", () => {
		for (const kind of AWS_INFRA_KIND_IDS) {
			const { sql } = compileUnsafe(awsInfraMetricsSQL(kind, "raw"), params)
			expect(sql, kind).not.toContain("IN ()")
			const [sums, gauges = ""] = Str.split("FROM metrics_gauge")(sql)
			const metrics = AWS_INFRA_KINDS[kind].metrics
			for (const metric of metrics) {
				const branch = metric.table === "sum" ? sums : gauges
				expect(branch, `${kind} ${metric.name}`).toContain(`'${metric.name}'`)
			}
			expect(metricNames(sql).sort(), kind).toEqual(Arr.map(metrics, (metric) => metric.name).sort())
		}
	})
})

describe("awsInfraMetricsSQL tiers", () => {
	it("reads whole hours from aws_metrics_hourly and only the partial hours from raw points", () => {
		const { sql, tenantScope } = compileUnsafe(awsInfraMetricsSQL("ec2", "hourly"), params)
		expect(tenantScope).toBe("single-tenant")
		expect(sql).toContain("FROM aws_metrics_hourly")
		expect(sql).toContain("aws_metrics_hourly.MetricType = 'sum'")
		expect(sql).toContain("aws_metrics_hourly.MetricType = 'gauge'")
		// Every raw branch is limited to the edges, so no hour is read from both tiers.
		expect(Str.split("FROM metrics_")(sql).length - 1).toBe(2)
		expect(Str.split("TimeUnix < if(")(sql).length - 1).toBe(2)
	})

	it("reads raw points only when the cluster has no rollup", () => {
		const { sql } = compileUnsafe(awsInfraMetricsSQL("ec2", "raw"), params)
		expect(sql).not.toContain("aws_metrics_hourly")
		expect(sql).not.toContain("TimeUnix < if(")
	})

	it("asks the rollup only for metrics its views write", () => {
		for (const kind of AWS_INFRA_KIND_IDS)
			for (const metric of AWS_INFRA_KINDS[kind].metrics)
				expect(Str.startsWith(AWS_METRIC_PREFIX)(metric.name), metric.name).toBe(true)
	})
})

describe("awsInfraSparklinesSQL", () => {
	it("reads only the sparkline metric, bucketed", () => {
		const { sql } = compileUnsafe(awsInfraSparklinesSQL("lambda", 1), { ...params, bucketSeconds: 300 })
		expect(metricNames(sql)).toEqual(["aws.lambda.invocations.sum"])
		expect(sql).toContain("GROUP BY keys, bucket, metric")
	})

	it("keeps every bucket of every resource the table reads", () => {
		const buckets = awsInfraBucketCount(params.startTime, params.endTime, 300)
		expect(buckets).toBe(145)
		const { sql } = compileUnsafe(awsInfraSparklinesSQL("ecs", buckets), {
			...params,
			bucketSeconds: 300,
		})
		expect(sql).toContain(`LIMIT ${AWS_INFRA_RESOURCE_LIMIT * 145}`)
	})
})

describe("awsInfraTimeseriesSQL", () => {
	it("binds a resource's keys to its dimensions, then region and account", () => {
		const keys = ["payments-api", "prod", "us-east-1", "123456789012"]
		const { sql } = compileUnsafe(awsInfraTimeseriesSQL("ecs", keys), { ...params, bucketSeconds: 60 })
		expect(sql).toContain("metrics_gauge.Attributes['aws.dimension.service_name'] = 'payments-api'")
		expect(sql).toContain("metrics_gauge.Attributes['aws.dimension.cluster_name'] = 'prod'")
		expect(sql).toContain("metrics_gauge.ResourceAttributes['cloud.region'] = 'us-east-1'")
		expect(sql).toContain("metrics_gauge.ResourceAttributes['cloud.account.id'] = '123456789012'")
	})

	it("keeps a quote in a resource name inside the value", () => {
		const keys = ["q' OR 1=1 --", "us-east-1", "1"]
		const { sql } = compileUnsafe(awsInfraTimeseriesSQL("sqs", keys), { ...params, bucketSeconds: 60 })
		expect(sql).toContain("Attributes['aws.dimension.queue_name'] = 'q\\' OR 1=1 --'")
	})
})

describe("awsInfraPresenceSQL", () => {
	it("asks the catalog about every kind's metrics", () => {
		const { sql } = compileUnsafe(awsInfraPresenceSQL(), params)
		const expected = Arr.flatMap(AWS_INFRA_KIND_IDS, (kind) =>
			Arr.map(AWS_INFRA_KINDS[kind].metrics, (m) => m.name),
		)
		expect(metricNames(sql).sort()).toEqual([...new Set(expected)].sort())
	})
})
