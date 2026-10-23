import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { AWS_INFRA_KIND_IDS, AWS_INFRA_KINDS, AWS_INFRA_RESOURCE_LIMIT } from "@maple/domain/aws-infra"
import {
	awsInfraBucketCount,
	awsInfraMetricsSQL,
	awsInfraPresenceSQL,
	awsInfraSparklinesSQL,
	awsInfraTimeseriesSQL,
} from "./aws-infra"

const params = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-10-23 00:00:00.000",
	endTime: "2026-10-23 12:00:00.000",
}

const metricNames = (sql: string) =>
	[...sql.matchAll(/'(aws\.(?!dimension\.)[a-z0-9_.]+)'/g)].map((m) => m[1])

describe("awsInfraMetricsSQL", () => {
	it("reads a load balancer's own series, never its per-target-group or per-zone copies", () => {
		const { sql, tenantScope } = compileUnsafe(awsInfraMetricsSQL("loadBalancers"), params)
		expect(tenantScope).toBe("single-tenant")
		// CloudWatch repeats RequestCount per target group and zone: those would count twice.
		expect(sql).toContain("metrics_sum.Attributes['aws.dimension.load_balancer'] != ''")
		expect(sql).toContain("metrics_sum.Attributes['aws.dimension.target_group'] = ''")
		expect(sql).toContain("metrics_sum.Attributes['aws.dimension.availability_zone'] = ''")
		expect(sql).toContain("GROUP BY keys, metric")
	})

	it("reads an ECS service's series, not its cluster's", () => {
		const { sql } = compileUnsafe(awsInfraMetricsSQL("ecs"), params)
		expect(sql).toContain("metrics_gauge.Attributes['aws.dimension.service_name'] != ''")
		expect(sql).toContain("metrics_gauge.Attributes['aws.dimension.cluster_name'] != ''")
	})

	it("reads every kind's sums from metrics_sum and means from metrics_gauge, none twice", () => {
		for (const kind of AWS_INFRA_KIND_IDS) {
			const { sql } = compileUnsafe(awsInfraMetricsSQL(kind), params)
			expect(sql, kind).not.toContain("IN ()")
			const [sums = "", gauges = ""] = sql.split("FROM metrics_gauge")
			const metrics = AWS_INFRA_KINDS[kind].metrics
			for (const metric of metrics) {
				const branch = metric.table === "sum" ? sums : gauges
				expect(branch, `${kind} ${metric.name}`).toContain(`'${metric.name}'`)
			}
			expect(metricNames(sql).sort(), kind).toEqual(metrics.map((metric) => metric.name).sort())
		}
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
		const expected = AWS_INFRA_KIND_IDS.flatMap((kind) =>
			AWS_INFRA_KINDS[kind].metrics.map((m) => m.name),
		)
		expect(metricNames(sql).sort()).toEqual([...new Set(expected)].sort())
	})
})
