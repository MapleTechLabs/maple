import type { BackfillSpec } from "../backfill"

// Migration 0071: person and group properties. `person_properties` and its three writers (product
// event `$set` keys, product-event span attributes, browser identify traits), plus
// `identity_links_events_mv` so server, mobile and trace events stitch visitors to users. Browser
// traits are backfilled from session_replays and server links from product_events; both targets
// aggregate, so a re-run collapses into the same rows. Frozen v71 DDL.

const traitsBackfill: BackfillSpec = {
	kind: "backfill",
	target: "person_properties",
	columns: [
		"OrgId",
		"Kind",
		"Id",
		"Key",
		"SetAt",
		"SetValue",
		"OnceAt",
		"OnceValue",
		"UnsetAt",
		"LastSeen",
	],
	from: "session_replays",
	tsColumn: "StartTime",
	select: "OrgId,\n          (arrayJoin(arrayConcat(\n            arrayMap((k, v) -> ('user', k, v), mapKeys(UserTraits), mapValues(UserTraits)),\n            [('group', 'name', GroupName)]\n          )) AS Trait).1 AS Kind,\n          if(Trait.1 = 'group', GroupId, UserId) AS Id,\n          Trait.2 AS Key,\n          max(ifNull(EndTime, StartTime)) AS SetAt,\n          argMaxIfState(Trait.3, ifNull(EndTime, StartTime), toUInt8(1)) AS SetValue,\n          toDateTime64('2199-12-31 23:59:59', 9, 'UTC') AS OnceAt,\n          argMinIfState('', ifNull(EndTime, StartTime), toUInt8(0)) AS OnceValue,\n          toDateTime64(0, 9, 'UTC') AS UnsetAt,\n          max(ifNull(EndTime, StartTime)) AS LastSeen",
	where: "if(Trait.1 = 'group', GroupId, UserId) != '' AND Trait.2 != '' AND Trait.3 != ''",
	// Positional: a chunked backfill sets `prefer_column_name_to_alias`, see 0048.
	groupBy: "1, 2, 3, 4",
}

const identityBackfill: BackfillSpec = {
	kind: "backfill",
	target: "identity_links",
	columns: ["OrgId", "VisitorId", "UserId", "FirstSeen"],
	from: "product_events",
	tsColumn: "Timestamp",
	select: "OrgId, VisitorId, UserId, min(Timestamp) AS FirstSeen",
	where: "Source != 'browser' AND VisitorId != '' AND UserId != ''",
	groupBy: "OrgId, VisitorId, UserId",
}

export const migration_0071_person_properties = {
	version: 71,
	description:
		"Create person_properties and its views from product events, product-event spans and browser traits, and link visitors to users from server, mobile and trace events",
	requiredForIngest: false,
	statements: [
		"DROP VIEW IF EXISTS identity_links_events_mv",
		"DROP VIEW IF EXISTS person_properties_events_mv",
		"DROP VIEW IF EXISTS person_properties_traces_mv",
		"DROP VIEW IF EXISTS person_properties_traits_mv",
		"CREATE TABLE IF NOT EXISTS person_properties (\n    OrgId LowCardinality(String),\n    Kind LowCardinality(String),\n    Id String,\n    Key String,\n    SetAt SimpleAggregateFunction(max, DateTime64(9)),\n    SetValue AggregateFunction(argMaxIf, String, DateTime64(9), UInt8),\n    OnceAt SimpleAggregateFunction(min, DateTime64(9)),\n    OnceValue AggregateFunction(argMinIf, String, DateTime64(9), UInt8),\n    UnsetAt SimpleAggregateFunction(max, DateTime64(9)),\n    LastSeen SimpleAggregateFunction(max, DateTime64(9))\n)\nENGINE = AggregatingMergeTree\nPARTITION BY tuple()\nORDER BY (OrgId, Kind, Key, Id)\nTTL toDate(LastSeen) + INTERVAL 365 DAY",
		traitsBackfill,
		identityBackfill,
		"CREATE MATERIALIZED VIEW IF NOT EXISTS identity_links_events_mv TO identity_links AS\nSELECT\n          OrgId,\n          VisitorId,\n          UserId,\n          min(Timestamp) AS FirstSeen\n        FROM product_events\n        WHERE Source != 'browser' AND VisitorId != '' AND UserId != ''\n        GROUP BY OrgId, VisitorId, UserId",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS person_properties_events_mv TO person_properties AS\nSELECT\n          OrgId,\n          if(startsWith(OpKey, '$group_'), 'group', 'user') AS Kind,\n          if(startsWith(OpKey, '$group_'), GroupId, UserId) AS Id,\n          substring(OpKey, position(OpKey, '.') + 1) AS Key,\n          maxIf(Timestamp, replaceOne(substring(OpKey, 2, position(OpKey, '.') - 2), 'group_', '') = 'set') AS SetAt,\n          argMaxIfState(Attributes[OpKey], Timestamp, replaceOne(substring(OpKey, 2, position(OpKey, '.') - 2), 'group_', '') = 'set') AS SetValue,\n          if(countIf(replaceOne(substring(OpKey, 2, position(OpKey, '.') - 2), 'group_', '') = 'set_once') = 0, toDateTime64('2199-12-31 23:59:59', 9, 'UTC'), minIf(Timestamp, replaceOne(substring(OpKey, 2, position(OpKey, '.') - 2), 'group_', '') = 'set_once')) AS OnceAt,\n          argMinIfState(Attributes[OpKey], Timestamp, replaceOne(substring(OpKey, 2, position(OpKey, '.') - 2), 'group_', '') = 'set_once') AS OnceValue,\n          maxIf(Timestamp, replaceOne(substring(OpKey, 2, position(OpKey, '.') - 2), 'group_', '') = 'unset') AS UnsetAt,\n          max(Timestamp) AS LastSeen\n        FROM product_events\n        ARRAY JOIN arrayFilter(k -> (startsWith(k, '$set.') OR startsWith(k, '$set_once.') OR startsWith(k, '$unset.') OR startsWith(k, '$group_set.') OR startsWith(k, '$group_set_once.') OR startsWith(k, '$group_unset.')), mapKeys(Attributes)) AS OpKey\n        WHERE if(startsWith(OpKey, '$group_'), GroupId, UserId) != '' AND substring(OpKey, position(OpKey, '.') + 1) != ''\n        GROUP BY OrgId, if(startsWith(OpKey, '$group_'), 'group', 'user'), if(startsWith(OpKey, '$group_'), GroupId, UserId), substring(OpKey, position(OpKey, '.') + 1)",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS person_properties_traces_mv TO person_properties AS\nSELECT\n          OrgId,\n          if(startsWith(OpKey, '$group_'), 'group', 'user') AS Kind,\n          if(startsWith(OpKey, '$group_'), SpanAttributes['maple.product_event.group_id'], SpanAttributes['maple.product_event.user_id']) AS Id,\n          substring(OpKey, position(OpKey, '.') + 1) AS Key,\n          maxIf(Timestamp, replaceOne(substring(OpKey, 2, position(OpKey, '.') - 2), 'group_', '') = 'set') AS SetAt,\n          argMaxIfState(SpanAttributes[concat('maple.product_event.', substring(OpKey, 2))], Timestamp, replaceOne(substring(OpKey, 2, position(OpKey, '.') - 2), 'group_', '') = 'set') AS SetValue,\n          if(countIf(replaceOne(substring(OpKey, 2, position(OpKey, '.') - 2), 'group_', '') = 'set_once') = 0, toDateTime64('2199-12-31 23:59:59', 9, 'UTC'), minIf(Timestamp, replaceOne(substring(OpKey, 2, position(OpKey, '.') - 2), 'group_', '') = 'set_once')) AS OnceAt,\n          argMinIfState(SpanAttributes[concat('maple.product_event.', substring(OpKey, 2))], Timestamp, replaceOne(substring(OpKey, 2, position(OpKey, '.') - 2), 'group_', '') = 'set_once') AS OnceValue,\n          maxIf(Timestamp, replaceOne(substring(OpKey, 2, position(OpKey, '.') - 2), 'group_', '') = 'unset') AS UnsetAt,\n          max(Timestamp) AS LastSeen\n        FROM traces\n        ARRAY JOIN arrayMap(\n          k -> concat('$', substring(k, 21)),\n          arrayFilter(k -> (startsWith(k, 'maple.product_event.set.') OR startsWith(k, 'maple.product_event.set_once.') OR startsWith(k, 'maple.product_event.unset.') OR startsWith(k, 'maple.product_event.group_set.') OR startsWith(k, 'maple.product_event.group_set_once.') OR startsWith(k, 'maple.product_event.group_unset.')), mapKeys(SpanAttributes))\n        ) AS OpKey\n        WHERE SpanAttributes['maple.product_event.name'] != '' AND if(startsWith(OpKey, '$group_'), SpanAttributes['maple.product_event.group_id'], SpanAttributes['maple.product_event.user_id']) != '' AND substring(OpKey, position(OpKey, '.') + 1) != ''\n        GROUP BY OrgId, if(startsWith(OpKey, '$group_'), 'group', 'user'), if(startsWith(OpKey, '$group_'), SpanAttributes['maple.product_event.group_id'], SpanAttributes['maple.product_event.user_id']), substring(OpKey, position(OpKey, '.') + 1)",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS person_properties_traits_mv TO person_properties AS\nSELECT\n          OrgId,\n          Trait.1 AS Kind,\n          if(Trait.1 = 'group', GroupId, UserId) AS Id,\n          Trait.2 AS Key,\n          max(ifNull(EndTime, StartTime)) AS SetAt,\n          argMaxIfState(Trait.3, ifNull(EndTime, StartTime), toUInt8(1)) AS SetValue,\n          toDateTime64('2199-12-31 23:59:59', 9, 'UTC') AS OnceAt,\n          argMinIfState('', ifNull(EndTime, StartTime), toUInt8(0)) AS OnceValue,\n          toDateTime64(0, 9, 'UTC') AS UnsetAt,\n          max(ifNull(EndTime, StartTime)) AS LastSeen\n        FROM session_replays\n        ARRAY JOIN arrayConcat(\n          arrayMap((k, v) -> ('user', k, v), mapKeys(UserTraits), mapValues(UserTraits)),\n          [('group', 'name', GroupName)]\n        ) AS Trait\n        WHERE if(Trait.1 = 'group', GroupId, UserId) != '' AND Trait.2 != '' AND Trait.3 != ''\n        GROUP BY OrgId, Trait.1, if(Trait.1 = 'group', GroupId, UserId), Trait.2",
	],
} as const
