import { describe, expect, it } from "vitest"
import {
	organizationHomeRegion,
	organizationRegionChosen,
	organizationRegionsFrom,
	organizationServedIn,
	parseMapleRegion,
} from "./organization-regions"

describe("organizationRegionsFrom", () => {
	it("treats an organization with no regions as US", () => {
		expect(organizationRegionsFrom(undefined)).toEqual(["us"])
		expect(organizationRegionsFrom({})).toEqual(["us"])
		expect(organizationRegionsFrom({ regions: [] })).toEqual(["us"])
	})

	it("reads the regions in order", () => {
		expect(organizationRegionsFrom({ regions: ["eu"] })).toEqual(["eu"])
		expect(organizationRegionsFrom({ regions: ["eu", "us"] })).toEqual(["eu", "us"])
	})

	it("drops unknown and duplicate entries", () => {
		expect(organizationRegionsFrom({ regions: ["mars", "eu", "eu", 3] })).toEqual(["eu"])
		expect(organizationRegionsFrom({ regions: ["mars"] })).toEqual(["us"])
		expect(organizationRegionsFrom({ regions: "eu" })).toEqual(["us"])
	})
})

describe("organizationServedIn", () => {
	it("serves an organization only in its regions", () => {
		expect(organizationServedIn({}, "us")).toBe(true)
		expect(organizationServedIn({}, "eu")).toBe(false)
		expect(organizationServedIn({ regions: ["eu"] }, "eu")).toBe(true)
		expect(organizationServedIn({ regions: ["eu"] }, "us")).toBe(false)
		expect(organizationHomeRegion({ regions: ["eu"] })).toBe("eu")
	})
})

describe("parseMapleRegion", () => {
	it("defaults anything unrecognised to US", () => {
		expect(parseMapleRegion("eu")).toBe("eu")
		expect(parseMapleRegion(" EU ")).toBe("eu")
		expect(parseMapleRegion(undefined)).toBe("us")
		expect(parseMapleRegion("")).toBe("us")
		expect(parseMapleRegion("ap")).toBe("us")
	})
})

describe("organizationRegionChosen", () => {
	it("is true only for an explicit, known region", () => {
		expect(organizationRegionChosen(undefined)).toBe(false)
		expect(organizationRegionChosen({ regions: [] })).toBe(false)
		expect(organizationRegionChosen({ regions: ["mars"] })).toBe(false)
		expect(organizationRegionChosen({ regions: ["us"] })).toBe(true)
		expect(organizationRegionChosen({ regions: ["eu"] })).toBe(true)
	})
})
