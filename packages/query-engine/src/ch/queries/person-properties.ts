// Person and group properties (`person_properties`): the values `identify()` traits, `$set` /
// `$set_once` / `$unset` event keys and `maple.product_event.<op>.*` span attributes leave behind.
// Every read resolves a key's merged rows with `PERSON_PROPERTY_VALUE_SQL`.

import { Schema } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { from } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { PERSON_PROPERTY_VALUE_SQL } from "@maple/domain/tinybird/product-event-attributes"
import { DateTimeUtcFromWarehouse64 } from "../../datetime"
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
			value: CH.rawExpr(`ifNull(${PERSON_PROPERTY_VALUE_SQL}, '')`, T.string),
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
