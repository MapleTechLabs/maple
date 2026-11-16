// Cloud security findings meet telemetry: which services emitted spans carrying a cloud resource's
// id in their resource attributes. Entry-point spans only, so the count reads as requests served.

import * as CH from "@maple-dev/effect-orm/expr"
import { from, param } from "@maple-dev/effect-orm/clickhouse"
import * as T from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { Array as Arr, Schema } from "effect"
import { CHNumber } from "../schema"
import { orgIdParam } from "../tables"

/** Resource attributes that carry an AWS resource's id, most specific first. */
export const CLOUD_RESOURCE_ATTRIBUTE_KEYS = [
	"host.id",
	"cloud.resource_id",
	"faas.name",
	"faas.id",
	"aws.ecs.task.arn",
	"aws.ecs.cluster.arn",
	"k8s.cluster.name",
	"container.image.name",
] as const

/** Most (resource, service) pairs returned: a page of findings touches a few services each. */
export const CLOUD_RESOURCE_SERVICES_MAX_ROWS = 1000

export interface CloudResourceServicesOpts {
	/** The ids to look for. Empty is the caller's to short-circuit: `IN ()` is invalid SQL. */
	readonly resourceIds: Arr.NonEmptyReadonlyArray<string>
}

export const cloudResourceServicesRowSchema = Schema.Struct({
	/** The id that matched, as one of `resourceIds`. */
	resourceId: Schema.String,
	service: Schema.String,
	/** Sample-weighted entry-point spans in the window. */
	requests: CHNumber,
})
export type CloudResourceServicesOutput = typeof cloudResourceServicesRowSchema.Type

/** Services that served requests from each resource over the window, busiest first. */
export function cloudResourceServicesQuery(opts: CloudResourceServicesOpts) {
	const ids = [...opts.resourceIds]
	return from(Datasources.traces)
		.select(($) => {
			const attribute = (key: string) => $.ResourceAttributes.get(key)
			return {
				resourceId: CH.multiIf(
					Arr.map(
						CLOUD_RESOURCE_ATTRIBUTE_KEYS,
						(key) => [CH.inList(attribute(key), ids), attribute(key)] as const,
					),
					CH.lit(""),
				),
				service: $.ServiceName,
				requests: CH.toUInt64(CH.sum($.SampleRate)),
			}
		})
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.IsEntryPoint.eq(1),
			// Prunes granules through the resource-attribute value bloom filter before the map reads.
			CH.compileTypedFnCall(
				"hasAny",
				T.uint8.schema,
				CH.mapValues($.ResourceAttributes),
				CH.arrayOf(...Arr.map(ids, (id) => CH.lit(id))),
			).eq(1),
			CH.or(
				...Arr.map(CLOUD_RESOURCE_ATTRIBUTE_KEYS, (key) =>
					CH.inList($.ResourceAttributes.get(key), ids),
				),
			),
		])
		.groupBy("resourceId", "service")
		.orderBy(["requests", "desc"])
		.limit(CLOUD_RESOURCE_SERVICES_MAX_ROWS)
		.format("JSON")
}
