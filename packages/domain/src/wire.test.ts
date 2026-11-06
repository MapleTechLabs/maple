import { describe, expect, it } from "vitest"
import { DateTime, Exit, Schema } from "effect"
import { ListLogsResponse } from "./http/query-engine"
import { WarehouseQueryResponse } from "./http/warehouse"
import { WireValue } from "./wire"

// HttpApi encodes responses through the JSON codec; a `DateTime.Utc` in an
// untyped field used to fail it, which surfaced as a sanitized 500.
const at = DateTime.makeUnsafe("2026-10-08T10:00:00.123Z")

describe("WireValue", () => {
	it("writes DateTime values at any depth as ISO", () => {
		const exit = Schema.encodeUnknownExit(Schema.toCodecJson(WireValue))({
			at,
			nested: [{ at }],
			n: 1,
			s: "x",
		})
		expect(exit).toStrictEqual(
			Exit.succeed({
				at: "2026-10-08T10:00:00.123Z",
				nested: [{ at: "2026-10-08T10:00:00.123Z" }],
				n: 1,
				s: "x",
			}),
		)
	})

	it("lets the forwarding responses encode decoded warehouse rows", () => {
		expect(
			Exit.isSuccess(
				Schema.encodeUnknownExit(Schema.toCodecJson(ListLogsResponse))(
					new ListLogsResponse({ data: [{ timestamp: at }] }),
				),
			),
		).toBe(true)
		expect(
			Exit.isSuccess(
				Schema.encodeUnknownExit(Schema.toCodecJson(WarehouseQueryResponse))(
					new WarehouseQueryResponse({ data: [{ bucket: at }] }),
				),
			),
		).toBe(true)
	})
})
