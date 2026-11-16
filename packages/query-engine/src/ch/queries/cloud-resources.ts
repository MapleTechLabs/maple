// Cloud security findings meet telemetry: which services emitted spans carrying a cloud resource's
// id in their resource attributes. Entry-point spans only, so the count reads as requests served.

import * as CH from "@maple-dev/effect-orm/expr"
import { from, param } from "@maple-dev/effect-orm/clickhouse"
import * as T from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import {
	CLOUD_RESOURCE_ATTRIBUTE_KEYS as DOMAIN_RESOURCE_KEYS,
	type CloudResourceCandidate,
} from "@maple/domain/cloud-security"
import { Array as Arr, Result, Schema } from "effect"
import { CHNumber } from "../schema"
import { orgIdParam } from "../tables"

/** Resource attributes that carry an AWS resource's identity, most specific first. */
export const CLOUD_RESOURCE_ATTRIBUTE_KEYS = DOMAIN_RESOURCE_KEYS

/** Most (resource, service) pairs returned: a page of findings touches a few services each. */
export const CLOUD_RESOURCE_SERVICES_MAX_ROWS = 1000

export interface CloudResourceServicesOpts {
	/** What to look for, each value on its own attribute. Empty is the caller's to short-circuit. */
	readonly candidates: Arr.NonEmptyReadonlyArray<CloudResourceCandidate>
}

export const cloudResourceServicesRowSchema = Schema.Struct({
	/** The attribute the value matched on: a finding joins on it and the value together. */
	attributeKey: Schema.String,
	/** The candidate value that matched. */
	resourceId: Schema.String,
	service: Schema.String,
	/** Sample-weighted entry-point spans in the window. */
	requests: CHNumber,
})
export type CloudResourceServicesOutput = typeof cloudResourceServicesRowSchema.Type

/** Services that served requests from each resource over the window, busiest first. */
export function cloudResourceServicesQuery(opts: CloudResourceServicesOpts) {
	// Each value appears once per attribute it may sit on, so the query stays small for long ARNs.
	const byKey = Arr.filterMap(CLOUD_RESOURCE_ATTRIBUTE_KEYS, (key) => {
		const values = Arr.dedupe(
			Arr.map(
				Arr.filter(opts.candidates, (candidate) => candidate.key === key),
				(candidate) => candidate.value,
			),
		)
		return Arr.isReadonlyArrayNonEmpty(values) ? Result.succeed({ key, values }) : Result.failVoid
	})
	const allValues = Arr.dedupe(Arr.map(opts.candidates, (candidate) => candidate.value))
	return from(Datasources.traces)
		.select(($) => {
			const attribute = (key: string) => $.ResourceAttributes.get(key)
			// Most specific attribute first: a span carrying two candidates counts once, for the first.
			return {
				attributeKey: CH.multiIf(
					Arr.map(
						byKey,
						({ key, values }) => [CH.inList(attribute(key), values), CH.lit(key)] as const,
					),
					CH.lit(""),
				),
				resourceId: CH.multiIf(
					Arr.map(
						byKey,
						({ key, values }) => [CH.inList(attribute(key), values), attribute(key)] as const,
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
				CH.arrayOf(...Arr.map(allValues, (value) => CH.lit(value))),
			).eq(1),
			CH.or(...Arr.map(byKey, ({ key, values }) => CH.inList($.ResourceAttributes.get(key), values))),
		])
		.groupBy("attributeKey", "resourceId", "service")
		.orderBy(["requests", "desc"])
		.limit(CLOUD_RESOURCE_SERVICES_MAX_ROWS)
		.format("JSON")
}
