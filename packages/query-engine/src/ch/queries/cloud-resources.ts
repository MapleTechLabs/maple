// Cloud security findings meet telemetry: which services emitted spans carrying a cloud resource's
// id in their resource attributes. Entry-point spans only, so the count reads as requests served.

import * as CH from "@maple-dev/effect-orm/expr"
import { from, param } from "@maple-dev/effect-orm/clickhouse"
import * as T from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import {
	CLOUD_RESOURCE_ATTRIBUTE_KEYS as DOMAIN_RESOURCE_KEYS,
	type CloudResourceAttributeKey,
	type CloudResourceCandidate,
} from "@maple/domain/cloud-security"
import { Array as Arr, Record as Rec, Result, Schema } from "effect"
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
	/** What matched, as `cloudResourceMatchTag` names a candidate: attribute, scope and value. */
	match: Schema.String,
	service: Schema.String,
	/** Sample-weighted entry-point spans in the window. */
	requests: CHNumber,
})
export type CloudResourceServicesOutput = typeof cloudResourceServicesRowSchema.Type

const SEPARATOR = "\u001f"

interface CandidateGroup {
	readonly key: CloudResourceAttributeKey
	readonly scope: CloudResourceCandidate["scope"]
	readonly values: Arr.NonEmptyReadonlyArray<string>
}

/** The candidates by attribute and scope, each value once per group. */
const groupsOf = (candidates: ReadonlyArray<CloudResourceCandidate>): ReadonlyArray<CandidateGroup> => {
	const scopeTag = (scope: CloudResourceCandidate["scope"]) =>
		scope === null ? "" : `${scope.accountId}/${scope.region}`
	const grouped = Arr.groupBy(
		candidates,
		(candidate) => `${candidate.key}${SEPARATOR}${scopeTag(candidate.scope)}`,
	)
	return Arr.filterMap(Rec.values(grouped), (group) =>
		group === undefined
			? Result.failVoid
			: Result.succeed({
					key: group[0].key,
					scope: group[0].scope,
					values: Arr.dedupe(Arr.map(group, (candidate) => candidate.value)),
				}),
	)
}

/**
 * Services that served requests from each candidate over the window, busiest first. A span counts
 * once for every candidate it carries (an ECS task and its cluster both get it), and a name only
 * when the span's account and region agree with the finding's or are unset. It returns one row past
 * the cap, so a caller can tell a capped answer from a complete one.
 */
export function cloudResourceServicesQuery(opts: CloudResourceServicesOpts) {
	const groups = groupsOf(opts.candidates)
	const allValues = Arr.dedupe(Arr.map(opts.candidates, (candidate) => candidate.value))
	return from(Datasources.traces)
		.select(($) => {
			const attribute = (key: string) => $.ResourceAttributes.get(key)
			const holds = (group: CandidateGroup) => {
				const named = CH.inList(attribute(group.key), group.values)
				return group.scope === null
					? named
					: named
							.and(CH.inList(attribute("cloud.account.id"), ["", group.scope.accountId]))
							.and(CH.inList(attribute("cloud.region"), ["", group.scope.region]))
			}
			const tagOf = (group: CandidateGroup) =>
				`${group.key}${SEPARATOR}${group.scope === null ? "" : `${group.scope.accountId}/${group.scope.region}`}${SEPARATOR}`
			return {
				// One row per group the span matches; "" for the groups it does not, dropped below.
				match: CH.arrayJoin(
					CH.arrayOf(
						...Arr.map(groups, (group) =>
							CH.if_(
								holds(group),
								CH.concat(CH.lit(tagOf(group)), attribute(group.key)),
								CH.lit(""),
							),
						),
					),
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
			CH.or(
				...Arr.map(groups, (group) => CH.inList($.ResourceAttributes.get(group.key), group.values)),
			),
		])
		.groupBy("match", "service")
		.having(() => [CH.dynamicColumn("match", T.string).neq("")])
		.orderBy(["requests", "desc"])
		.limit(CLOUD_RESOURCE_SERVICES_MAX_ROWS + 1)
		.format("JSON")
}
