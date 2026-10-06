import * as T from "@maple-dev/effect-orm/clickhouse"
import { DateTime, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
	DateTimeUtcFromWarehouse,
	DateTimeUtcFromWarehouse64,
	formatWarehouseDateTime,
	formatWarehouseDateTimeMs,
} from "./datetime"

const decode = Schema.decodeUnknownSync(DateTimeUtcFromWarehouse)
const encode = Schema.encodeSync(DateTimeUtcFromWarehouse)
const decode64 = Schema.decodeUnknownSync(DateTimeUtcFromWarehouse64)
const encode64 = Schema.encodeSync(DateTimeUtcFromWarehouse64)

// What effect-orm's `T.dateTime` / `T.dateTime64` columns hand the backend.
const fromColumn = Schema.decodeUnknownSync(T.dateTime.schema)
const fromColumn64 = Schema.decodeUnknownSync(T.dateTime64.schema)

describe("DateTimeUtcFromWarehouse", () => {
	it("decodes the tz-less wire string as UTC", () => {
		expect(DateTime.toEpochMillis(decode("2026-10-07 10:00:00"))).toBe(Date.UTC(2026, 9, 7, 10, 0, 0))
	})

	it("round-trips the DateTime wire string byte for byte", () => {
		for (const wire of ["2026-10-07 10:00:00", "1970-01-01 00:00:00", "2024-02-29 23:59:59"]) {
			expect(encode(decode(wire))).toBe(wire)
			expect(encode(fromColumn(wire))).toBe(wire)
		}
	})

	it("matches today's formatter and floors sub-second values", () => {
		const ms = Date.UTC(2026, 9, 7, 10, 0, 0, 999)
		expect(encode(DateTime.makeUnsafe(ms))).toBe(formatWarehouseDateTime(ms))
		expect(encode(DateTime.makeUnsafe(ms))).toBe("2026-10-07 10:00:00")
	})

	it("accepts ISO input and normalizes offsets to UTC", () => {
		expect(encode(decode("2026-10-07T12:00:00+02:00"))).toBe("2026-10-07 10:00:00")
		expect(encode(decode("2026-10-07T10:00:00Z"))).toBe("2026-10-07 10:00:00")
	})

	it("rejects non-timestamps and impossible dates", () => {
		for (const bad of ["", "2026", "Oct 7 2026", "2026-02-30 00:00:00", "2026-10-07 24:00:00"]) {
			expect(() => decode(bad), bad).toThrow()
		}
	})
})

describe("DateTimeUtcFromWarehouse64", () => {
	it("round-trips the DateTime64(3) wire string byte for byte", () => {
		for (const wire of ["2026-10-07 10:00:00.000", "2026-10-07 10:00:00.041", "2026-10-07 10:00:00.900"]) {
			expect(encode64(decode64(wire))).toBe(wire)
			expect(encode64(fromColumn64(wire))).toBe(wire)
		}
	})

	it("keeps trailing zeros, matching today's formatter", () => {
		const ms = Date.UTC(2026, 9, 7, 10, 0, 0, 120)
		expect(encode64(DateTime.makeUnsafe(ms))).toBe(formatWarehouseDateTimeMs(ms))
		expect(encode64(DateTime.makeUnsafe(ms))).toBe("2026-10-07 10:00:00.120")
	})

	it("truncates nanoseconds: DateTime64(9) columns cannot use this codec", () => {
		expect(encode64(decode64("2026-10-07 10:00:00.123456789"))).toBe("2026-10-07 10:00:00.123")
	})
})
