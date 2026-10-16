const attributeItems = (itemsColumn: string, mapColumn: string): string =>
	`${itemsColumn} Array(String) DEFAULT arrayMap((k, v) -> concat(k, char(31), v), mapKeys(${mapColumn}), mapValues(${mapColumn}))`

/**
 * Columns only self-managed ClickHouse stores, by table. They back the
 * `search_text_v1` text indexes (`features.ts`). Tinybird has no text index,
 * so its datasources leave them out and the emitter appends them to the
 * ClickHouse DDL.
 */
export const clickHouseOnlyColumns: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	[
		"logs",
		[
			attributeItems("ResourceAttributeItems", "ResourceAttributes"),
			attributeItems("ScopeAttributeItems", "ScopeAttributes"),
			attributeItems("LogAttributeItems", "LogAttributes"),
		],
	],
	[
		"traces",
		[
			attributeItems("ResourceAttributeItems", "ResourceAttributes"),
			attributeItems("ScopeAttributeItems", "ScopeAttributes"),
			attributeItems("SpanAttributeItems", "SpanAttributes"),
		],
	],
])
