// AWS ingest
//
// What one AWS connection's metric stream stored, by CloudWatch namespace and
// region. The ingest gateway expands every CloudWatch point into gauges plus a
// `.count` delta sum, so the `.count` rows of `metrics_sum` are one per point.

import { Schema } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { from, param } from "@maple-dev/effect-orm/clickhouse"
import { CHNumber } from "../schema"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam } from "../tables"

/** The instrumentation scope the gateway stamps on metric stream data. */
export const AWS_METRIC_STREAM_SCOPE = "aws.cloudwatch.metric_stream"

/** Resources listed per namespace and region; the count covers the rest. */
export const AWS_INGEST_RESOURCE_SAMPLE = 8

export const awsIngestRowSchema = Schema.Struct({
	/** The CloudWatch namespace, `AWS/ECS`. */
	namespace: Schema.String,
	/** The stream's region; empty when the stream did not say. */
	region: Schema.String,
	/** Distinct CloudWatch metric names. */
	metrics: CHNumber,
	/** CloudWatch data points received. */
	dataPoints: CHNumber,
	/** Distinct `service.name`s: the most specific dimension, else `aws/<namespace>`. */
	resources: CHNumber,
	sampleResources: Schema.Array(Schema.String),
	/** ClickHouse DateTime64 literal of the newest point. */
	lastPointAt: Schema.String,
})

export type AwsIngestOutput = typeof awsIngestRowSchema.Type

/** One connection's stored points per namespace and region. Params: orgId, connectionId, startTime, endTime. */
export function awsIngestQuery() {
	return from(Datasources.metricsSum)
		.select(($) => ({
			namespace: $.Attributes.get("aws.namespace"),
			region: $.ResourceAttributes.get("cloud.region"),
			metrics: CH.uniq($.Attributes.get("aws.metric_name")),
			dataPoints: CH.count(),
			resources: CH.uniq($.ServiceName),
			sampleResources: CH.rawExpr(
				`arraySort(groupUniqArray(${AWS_INGEST_RESOURCE_SAMPLE})(ServiceName))`,
				T.array(T.string),
			),
			lastPointAt: CH.toString_(CH.max_($.TimeUnix)),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.ScopeName.eq(AWS_METRIC_STREAM_SCOPE),
			$.MetricName.like("aws.%.count"),
			$.ResourceAttributes.get("maple_aws_connection_id").eq(param.string("connectionId")),
		])
		.groupBy("namespace", "region")
		.orderBy(["dataPoints", "desc"])
		.limit(200)
		.format("JSON")
}
