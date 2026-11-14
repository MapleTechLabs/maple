import { describe, expect, it } from "vitest"
import { enumValues, mapClickHouseType, pickTimeField, wideNumber } from "./types"
import { parseGrants, grantWarnings } from "./test-connection"

describe("mapClickHouseType", () => {
	it.each([
		["String", "string"],
		["LowCardinality(Nullable(String))", "string"],
		["Enum8('a' = 1)", "string"],
		["UUID", "string"],
		["UInt64", "number"],
		["Nullable(Decimal(12, 2))", "number"],
		["Float64", "number"],
		["Bool", "boolean"],
		["DateTime64(9, 'UTC')", "timestamp"],
		["Nullable(Date32)", "timestamp"],
		["Map(String, String)", "json"],
		["Array(UInt8)", "json"],
		["JSON", "json"],
		["AggregateFunction(uniq, String)", "unknown"],
	] as const)("%s -> %s", (native, mapped) => {
		expect(mapClickHouseType(native)).toBe(mapped)
	})
})

describe("enumValues", () => {
	it("reads Enum8/Enum16 labels, escapes included, through wrappers", () => {
		expect(enumValues("Enum8('pending' = 1, 'paid' = 2, 'refunded' = 3)")).toEqual([
			"pending",
			"paid",
			"refunded",
		])
		expect(enumValues("LowCardinality(Nullable(Enum16('it\\'s' = -1, 'a,b' = 300)))")).toEqual([
			"it's",
			"a,b",
		])
		expect(enumValues("String")).toEqual([])
	})
})

describe("wideNumber", () => {
	it("converts safe 64-bit integers and decimals, keeps unsafe ones as strings", () => {
		expect(wideNumber("UInt64", "42")).toBe(42)
		expect(wideNumber("UInt64", "18446744073709551615")).toBe("18446744073709551615")
		expect(wideNumber("Nullable(Decimal(12, 2))", "12.5")).toBe(12.5)
		expect(wideNumber("String", "42")).toBe("42")
		expect(wideNumber("Decimal(38, 2)", "12.50")).toBe(12.5)
		expect(wideNumber("Decimal(38, 2)", "-0.00")).toBe(0)
		// Past double precision the exact string is kept, never a rounded number.
		expect(wideNumber("Decimal(38, 2)", "12345678901234567.89")).toBe("12345678901234567.89")
		expect(wideNumber("Decimal(38, 10)", "0.1234567890")).toBe(0.123456789)
		expect(wideNumber("Decimal(76, 30)", "1.000000000000000000000000000001")).toBe(
			"1.000000000000000000000000000001",
		)
	})
})

describe("pickTimeField", () => {
	it("prefers a time column in the sorting key, then a conventional name", () => {
		const columns = [
			{ name: "created_at", nativeType: "DateTime", inSortingKey: false },
			{ name: "paid_at", nativeType: "Nullable(DateTime64(3))", inSortingKey: true },
		]
		expect(pickTimeField(columns)).toBe("paid_at")
		expect(
			pickTimeField([
				{ name: "created_at", nativeType: "DateTime", inSortingKey: false },
				{ name: "x", nativeType: "Date", inSortingKey: false },
			]),
		).toBe("created_at")
		expect(
			pickTimeField([{ name: "created_at", nativeType: "String", inSortingKey: true }]),
		).toBeUndefined()
	})
})

describe("grant warnings", () => {
	it("names write privileges and stays quiet for SELECT-only users", () => {
		expect(grantWarnings(parseGrants(["GRANT SELECT, INSERT ON shop.* TO writer"]))).toEqual([
			"This user can write (INSERT on shop.*). Maple only reads, but a read-only user is safer.",
		])
		expect(grantWarnings(parseGrants(["GRANT SELECT(a, b), SHOW TABLES ON shop.t TO reader"]))).toEqual(
			[],
		)
		expect(grantWarnings(parseGrants(["GRANT ALL ON *.* TO admin WITH GRANT OPTION"]))[0]).toContain(
			"ALL on *.*",
		)
		expect(grantWarnings(parseGrants(["GRANT analyst TO bob"]))[0]).toContain("roles (analyst)")
	})
})
