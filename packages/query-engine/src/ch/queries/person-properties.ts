// Person and group properties (`person_properties`): the values `identify()` traits, `$set` /
// `$set_once` / `$unset` event keys and `maple.product_event.<op>.*` span attributes leave behind.
// Every read resolves a key's merged rows with `PERSON_PROPERTY_VALUE_SQL`.

import { Array as Arr, Schema } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { from, fromQuery, inSubquery, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import type { AttributeFilter, AttributeFilterLeaf } from "@maple/domain/query-engine"
import * as Datasources from "@maple/domain/tinybird/datasources"
import {
	PERSON_PROPERTY_NEVER_SQL,
	PERSON_PROPERTY_VALUE_SQL,
} from "@maple/domain/tinybird/product-event-attributes"
import { DateTimeUtcFromWarehouse64 } from "../../datetime"
import { CHNumber } from "../schema"
import { orgIdParam } from "../tables"

/** `user` reads a user id's properties, `group` a group (account) id's. */
export type PersonPropertyKind = "user" | "group"

export interface PersonPropertiesOpts {
	readonly kind: PersonPropertyKind
	/** The users or groups to read. */
	readonly ids: ReadonlyArray<string>
	readonly limit?: number
}

export const personPropertyRowSchema = Schema.Struct({
	id: Schema.String,
	key: Schema.String,
	value: Schema.String,
	lastSeen: DateTimeUtcFromWarehouse64,
})
export type PersonPropertyRow = typeof personPropertyRowSchema.Type

/** The value of each property these users or groups hold, by id then key; unset keys are left out. */
export function personPropertiesQuery(opts: PersonPropertiesOpts) {
	return from(Datasources.personProperties)
		.select(($) => ({
			id: $.Id,
			key: $.Key,
			value: resolvedValue(),
			lastSeen: CH.max_($.LastSeen),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Kind.eq(opts.kind),
			opts.ids.length === 0 ? CH.rawCond("1 = 0") : CH.inList($.Id, opts.ids),
		])
		.groupBy("id", "key")
		.having(() => [CH.rawCond(`${PERSON_PROPERTY_VALUE_SQL} IS NOT NULL`)])
		.orderBy(["id", "asc"], ["key", "asc"])
		.limit(opts.limit ?? 5_000)
		.format("JSON")
}

export const personPropertyStateRowSchema = Schema.Struct({
	id: Schema.String,
	key: Schema.String,
	/** `''` when cleared. */
	value: Schema.String,
	/** 1 when an `unset` cleared the key after its last write. */
	cleared: CHNumber,
	/** Epoch ms of the key's latest write (`set`, `unset` or first `set_once`). */
	writtenAtMs: CHNumber,
})
export type PersonPropertyStateRow = typeof personPropertyStateRowSchema.Type

/**
 * Every key these users or groups ever wrote, cleared ones included, with when it was last written:
 * what a reader merging another source of the same values needs to tell which is newer.
 */
export function personPropertyStatesQuery(opts: PersonPropertiesOpts) {
	return from(Datasources.personProperties)
		.select(($) => ({
			id: $.Id,
			key: $.Key,
			value: resolvedValue(),
			cleared: CH.rawExpr(`toUInt8(isNull(${PERSON_PROPERTY_VALUE_SQL}))`, T.uint8),
			writtenAtMs: CH.rawExpr(
				`toFloat64(toUnixTimestamp64Milli(greatest(max(SetAt), max(UnsetAt), if(min(OnceAt) < ${PERSON_PROPERTY_NEVER_SQL}, min(OnceAt), toDateTime64(0, 9, 'UTC')))))`,
				T.float64,
			),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Kind.eq(opts.kind),
			opts.ids.length === 0 ? CH.rawCond("1 = 0") : CH.inList($.Id, opts.ids),
		])
		.groupBy("id", "key")
		.orderBy(["id", "asc"], ["key", "asc"])
		.limit(opts.limit ?? 5_000)
		.format("JSON")
}

const resolvedValue = (): CH.Expr<string> => CH.rawExpr(`ifNull(${PERSON_PROPERTY_VALUE_SQL}, '')`, T.string)

/** The keys of one kind's properties: one contiguous range of the sort key. */
const keyRange = (
	$: ColumnAccessor<typeof Datasources.personProperties.columns>,
	kind: PersonPropertyKind,
	key: string,
) => [$.OrgId.eq(orgIdParam), $.Kind.eq(kind), $.Key.eq(key)]

/** A property's value as a finite number, NULL for text, so a comparison never matches it. */
const numeric = (value: CH.Expr<string>): CH.Expr<number | null> => {
	const parsed = CH.compileTypedFnCall("toFloat64OrNull", T.nullable(T.float64).schema, value)
	return CH.compileTypedFnCall(
		"if",
		T.nullable(T.float64).schema,
		CH.compileFnCallCond("isFinite", parsed),
		parsed,
		CH.rawExpr("NULL", T.nullable(T.float64)),
	)
}

/**
 * `value` holds for a property's current value (`''` when it has none). The same reading as
 * `buildAttrFilterCondition` gives an event attribute, without its negation.
 */
function valueCondition(value: CH.Expr<string>, filter: AttributeFilterLeaf): CH.Condition {
	const target = filter.value ?? ""
	switch (filter.mode) {
		case "exists":
			return value.neq("")
		case "contains":
			return CH.positionCaseInsensitive(value, CH.lit(target)).gt(0)
		case "in":
			return filter.values === undefined || filter.values.length === 0
				? CH.rawCond("0")
				: CH.inList(value, filter.values)
		case "gt":
			return numeric(value).gt(Number(target))
		case "gte":
			return numeric(value).gte(Number(target))
		case "lt":
			return numeric(value).lt(Number(target))
		case "lte":
			return numeric(value).lte(Number(target))
		case "equals":
			return value.eq(target)
	}
}

/** The users or groups whose property `filter.key` currently matches `filter`, ignoring `negated`. */
function matchingIds(kind: PersonPropertyKind, filter: AttributeFilterLeaf) {
	return (
		from(Datasources.personProperties)
			.select(($) => ({ Id: $.Id }))
			.where(($) => keyRange($, kind, filter.key))
			.groupBy("Id")
			// A cleared key holds no value: it matches nothing, not `''`.
			.having(() => [
				CH.rawCond(`${PERSON_PROPERTY_VALUE_SQL} IS NOT NULL`),
				valueCondition(resolvedValue(), filter),
			])
	)
}

/**
 * Events whose user (`kind: "user"`, `id` the event's user id or person key) or group matches a
 * property filter. Negated, it keeps every event whose id does NOT match, those with no id or no
 * value for the key included, the way `!=` reads an event attribute that is missing.
 */
export function propertyFilterCondition(
	id: CH.Expr<string>,
	kind: PersonPropertyKind,
	filter: AttributeFilter,
): CH.Condition {
	if (filter.or !== undefined && filter.or.length > 0) {
		const { or, ...first } = filter
		return CH.or(...Arr.map([first, ...or], (leaf) => propertyFilterCondition(id, kind, leaf)))
	}
	const matched = inSubquery(id, matchingIds(kind, filter))
	return filter.negated === true ? CH.not(matched) : matched
}

/** One row per user or group holding `key`: its id and current value, to join for a breakdown. */
export function propertyValuesById(kind: PersonPropertyKind, key: string) {
	return from(Datasources.personProperties)
		.select(($) => ({ Id: $.Id, value: resolvedValue() }))
		.where(($) => keyRange($, kind, key))
		.groupBy("Id")
}

export interface PersonPropertyKeysOpts {
	readonly kind: PersonPropertyKind
	readonly limit?: number
}

export const personPropertyKeyRowSchema = Schema.Struct({
	key: Schema.String,
	ids: CHNumber,
})

/** The property keys one kind carries, by how many users or groups hold them. */
export function personPropertyKeysQuery(opts: PersonPropertyKeysOpts) {
	return from(Datasources.personProperties)
		.select(($) => ({ key: $.Key, ids: CH.uniq($.Id) }))
		.where(($) => [$.OrgId.eq(orgIdParam), $.Kind.eq(opts.kind)])
		.groupBy("key")
		.orderBy(["ids", "desc"], ["key", "asc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}

export interface PersonPropertyValuesOpts {
	readonly kind: PersonPropertyKind
	readonly key: string
	readonly limit?: number
}

export const personPropertyValueRowSchema = Schema.Struct({
	value: Schema.String,
	ids: CHNumber,
})

/** One property's current values, by how many users or groups hold each. */
export function personPropertyValuesQuery(opts: PersonPropertyValuesOpts) {
	return fromQuery(propertyValuesById(opts.kind, opts.key), "p")
		.select(($) => ({ value: $.value, ids: CH.count() }))
		.where(($) => [$.value.neq("")])
		.groupBy("value")
		.orderBy(["ids", "desc"], ["value", "asc"])
		.limit(opts.limit ?? 100)
		.format("JSON")
}
