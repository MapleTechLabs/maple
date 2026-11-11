import { assert, describe, it } from "@effect/vitest"
import { Number as Num, Option, Result, Array as Arr } from "effect"
import { FIXTURE_DAYS, FIXTURE_DETAILED, FIXTURE_ITEMS, FIXTURE_WINDOW } from "./cost-fixture"
import { answerCostExplorer, type FakeCostRequest } from "./fake-cost-explorer"
import {
	type CostExplorerResult,
	type CostGroup,
	costExplorerPeriod,
	detailedRegions,
	MAX_DETAILED_REGIONS,
	parseGroups,
	serviceCategoryOf,
	serviceRows,
	usageRows,
	usageReconciles,
} from "./normalize"

const ACCOUNT = "000000000000"

const request = (second: string, region?: string): FakeCostRequest => {
	const all = {
		TimePeriod: { Start: "2026-02-27", End: "2026-03-02" },
		Granularity: "DAILY",
		Metrics: ["UnblendedCost", "AmortizedCost", "UsageQuantity"],
		GroupBy: [
			{ Type: "DIMENSION", Key: "SERVICE" },
			{ Type: "DIMENSION", Key: second },
		],
	}
	return region === undefined
		? all
		: { ...all, Filter: { Dimensions: { Key: "REGION", Values: [region] } } }
}

const parsed = (results: ReadonlyArray<CostExplorerResult>) =>
	Result.getOrElse(parseGroups(results), (message): ReadonlyArray<CostGroup> => {
		assert.fail(message)
	})

const group = (region: string, cost: number, amortized = cost): CostGroup => ({
	day: "2026-03-01",
	estimated: false,
	service: "Invented Service",
	key: region,
	currency: "USD",
	billedCost: cost,
	effectiveCost: amortized,
	quantity: 0,
	unit: "",
})

const oneGroup = (metrics: Record<string, { Amount?: string; Unit?: string }>): CostExplorerResult => ({
	TimePeriod: { Start: "2026-03-01", End: "2026-03-02" },
	Estimated: true,
	Groups: [{ Keys: ["Invented Service", "EUC1-Invented-Usage"], Metrics: metrics }],
})

const usd = (Amount: string) => ({ Amount, Unit: "USD" })

describe("costExplorerPeriod", () => {
	it("ends the day after the window's last, across a month's end", () => {
		assert.deepStrictEqual(
			costExplorerPeriod(FIXTURE_WINDOW),
			Option.some({ Start: "2026-02-27", End: "2026-03-02", days: 3 }),
		)
		assert.deepStrictEqual(
			costExplorerPeriod({ startDay: "2026-12-31", endDay: "2026-12-31" }),
			Option.some({ Start: "2026-12-31", End: "2027-01-01", days: 1 }),
		)
	})

	it("refuses a day the calendar lacks and a reversed window", () => {
		assert.isTrue(Option.isNone(costExplorerPeriod({ startDay: "2026-02-30", endDay: "2026-03-02" })))
		assert.isTrue(Option.isNone(costExplorerPeriod({ startDay: "2026-03-02", endDay: "2026-03-01" })))
		assert.isTrue(Option.isNone(costExplorerPeriod({ startDay: "2026-3-1", endDay: "2026-03-02" })))
	})
})

describe("detailedRegions", () => {
	it("leaves out a region under a cent a day, whatever its share", () => {
		// Ten days: a region needs USD 0.10. The small one holds a tenth of the cost and still falls short.
		const groups = [group("eu-central-1", 0.45), group("us-west-2", 0.05)]
		assert.deepStrictEqual(detailedRegions(groups, 10), ["eu-central-1"])
		// Over one day the same USD 0.05 is enough.
		assert.deepStrictEqual(detailedRegions(groups, 1), ["eu-central-1", "us-west-2"])
	})

	it("leaves out a region under a thousandth of the cost, whatever its amount", () => {
		const groups = [group("eu-central-1", 10000), group("us-west-2", 5), group("sa-east-1", 10.02)]
		assert.deepStrictEqual(detailedRegions(groups, 10), ["eu-central-1", "sa-east-1"])
	})

	it("adds a region's groups up before judging it", () => {
		const groups = Arr.makeBy(8, () => group("us-west-2", 0.02))
		assert.deepStrictEqual(detailedRegions(groups, 10), ["us-west-2"])
	})

	it("counts credits and amortized cost by their size", () => {
		const groups = [group("eu-central-1", 40), group("us-west-2", -25), group("sa-east-1", 0, 12)]
		assert.deepStrictEqual(detailedRegions(groups, 10), ["eu-central-1", "sa-east-1", "us-west-2"])
	})

	it("keeps `global` as a region and never filters on the empty one", () => {
		const groups = [group("global", 30), group("", 30)]
		assert.deepStrictEqual(detailedRegions(groups, 10), ["global"])
	})

	it("finds nothing in a window without cost", () => {
		assert.deepStrictEqual(detailedRegions([group("eu-central-1", 0)], 10), [])
	})
})

describe("detailedRegions cap", () => {
	it("keeps only the largest regions when more are worth a pull than a pull may make", () => {
		const groups = Arr.map(Arr.range(1, MAX_DETAILED_REGIONS + 3), (n) => group(`region-${n}`, n * 10))
		const regions = detailedRegions(groups, 1)
		assert.strictEqual(regions.length, MAX_DETAILED_REGIONS)
		// The three smallest are the ones left to their service-level rows.
		assert.isFalse(
			Arr.some(regions, (region) => Arr.contains(["region-1", "region-2", "region-3"], region)),
		)
	})
})

describe("usageReconciles", () => {
	const byRegion = [group("eu-central-1", 30, 28), group("us-west-2", 5)]
	const usage = (cost: number, amortized = cost) => ({ ...group("Usage-Type", cost, amortized) })

	it("accepts a pull that holds the region's money, split differently", () => {
		assert.isTrue(usageReconciles([usage(10, 9), usage(20, 19)], byRegion, "eu-central-1"))
		// Float noise from summing many small amounts is not a mismatch.
		assert.isTrue(usageReconciles([usage(30.0000001, 28)], byRegion, "eu-central-1"))
	})

	it("refuses a pull that misses a charge, on either cost", () => {
		assert.isFalse(usageReconciles([usage(10, 9)], byRegion, "eu-central-1"))
		assert.isFalse(usageReconciles([usage(30, 20)], byRegion, "eu-central-1"))
		assert.isFalse(usageReconciles([], byRegion, "eu-central-1"))
	})

	it("compares each service, so a charge and an equal credit do not hide a miss of both", () => {
		const of = (service: string, costGroup: CostGroup): CostGroup => ({ ...costGroup, service })
		const netZero = [
			of("Invented Compute", group("eu-central-1", 100)),
			of("Invented Credit", group("eu-central-1", -100)),
			of("Invented Storage", group("eu-central-1", 5)),
		]
		// The day nets to 5 either way: a pull missing the charge and its credit must not pass.
		assert.isFalse(usageReconciles([of("Invented Storage", usage(5))], netZero, "eu-central-1"))
		assert.isTrue(
			usageReconciles(
				[
					of("Invented Compute", usage(60)),
					of("Invented Compute", usage(40)),
					of("Invented Credit", usage(-100)),
					of("Invented Storage", usage(5)),
				],
				netZero,
				"eu-central-1",
			),
		)
	})

	it("compares day by day, so a miss on one day is not hidden by the window", () => {
		const on = (day: string, costGroup: CostGroup): CostGroup => ({ ...costGroup, day })
		const twoDays = [
			on("2026-03-01", group("eu-central-1", 1000)),
			on("2026-03-02", group("eu-central-1", 1000)),
		]
		// A charge of 0.50 missing on one day is far under a thousandth of the window's 2,000.
		assert.isFalse(
			usageReconciles(
				[on("2026-03-01", usage(1000)), on("2026-03-02", usage(999.5))],
				twoDays,
				"eu-central-1",
			),
		)
		// Two days whose misses cancel in the window total still do not match.
		assert.isFalse(
			usageReconciles(
				[on("2026-03-01", usage(1010)), on("2026-03-02", usage(990))],
				twoDays,
				"eu-central-1",
			),
		)
		assert.isTrue(
			usageReconciles(
				[on("2026-03-01", usage(1000)), on("2026-03-02", usage(1000))],
				twoDays,
				"eu-central-1",
			),
		)
	})
})

describe("cost rows", () => {
	const byRegion = parsed(answerCostExplorer(FIXTURE_ITEMS, request("REGION")).ResultsByTime)
	const regions = detailedRegions(byRegion, 3)
	const rows = [
		...Arr.flatMap(regions, (region) =>
			usageRows(
				parsed(answerCostExplorer(FIXTURE_ITEMS, request("USAGE_TYPE", region)).ResultsByTime),
				ACCOUNT,
				region,
			),
		),
		...serviceRows(byRegion, ACCOUNT, regions),
	]

	it("details the regions with real spend only", () => {
		assert.deepStrictEqual(regions, FIXTURE_DETAILED)
	})

	it("adds up to each day's total of the region query, billed and amortized", () => {
		Arr.forEach(FIXTURE_DAYS, (day) => {
			const ofDay = Arr.filter(rows, (row) => row.day === day)
			const expected = Arr.filter(byRegion, (entry) => entry.day === day)
			assert.isAbove(ofDay.length, 0)
			assert.closeTo(
				Num.sumAll(Arr.map(ofDay, (row) => row.billedCost)),
				Num.sumAll(Arr.map(expected, (entry) => entry.billedCost)),
				1e-9,
			)
			assert.closeTo(
				Num.sumAll(Arr.map(ofDay, (row) => row.effectiveCost)),
				Num.sumAll(Arr.map(expected, (entry) => entry.effectiveCost)),
				1e-9,
			)
		})
	})

	it("gives a detailed region its usage types, quantities and units", () => {
		const compute = Arr.findFirst(
			rows,
			(row) => row.day === "2026-02-27" && row.usageType === "EUC1-BoxUsage:m7g.large",
		)
		assert.deepStrictEqual(Option.getOrUndefined(compute), {
			day: "2026-02-27",
			accountId: ACCOUNT,
			cloudService: "Amazon Elastic Compute Cloud - Compute",
			serviceCategory: "Compute",
			usageType: "EUC1-BoxUsage:m7g.large",
			region: "eu-central-1",
			resourceId: "",
			resourceType: "",
			serviceName: "",
			chargeCategory: "unknown",
			basis: "billed",
			currency: "USD",
			billedCost: 4.8,
			effectiveCost: 3.6,
			listCost: 0,
			consumedQuantity: 48,
			consumedUnit: "Hrs",
			tags: {},
			estimated: false,
		})
	})

	it("keeps a small region at service level, without usage type or quantity", () => {
		const small = Arr.filter(rows, (row) => row.region === "ap-southeast-2")
		assert.lengthOf(small, 3)
		Arr.forEach(small, (row) => {
			assert.strictEqual(row.cloudService, "AWS CloudTrail")
			assert.strictEqual(row.usageType, "")
			assert.strictEqual(row.consumedQuantity, 0)
			assert.strictEqual(row.consumedUnit, "")
			assert.strictEqual(row.billedCost, 0.004)
		})
	})

	it("marks tax as its own charge category, under the region it came with", () => {
		const tax = Arr.filter(rows, (row) => row.chargeCategory === "tax")
		assert.deepStrictEqual(
			Arr.map(tax, (row) => [row.cloudService, row.region, row.day, row.billedCost]),
			[["Tax", "", "2026-03-01", 1.9]],
		)
		assert.isTrue(
			Arr.every(rows, (row) => row.cloudService === "Tax" || row.chargeCategory === "unknown"),
		)
	})

	it("drops a usage type that cost nothing", () => {
		assert.isFalse(Arr.some(rows, (row) => row.cloudService === "AWS Key Management Service"))
		assert.isTrue(Arr.every(rows, (row) => row.billedCost !== 0 || row.effectiveCost !== 0))
	})

	it("carries each day's estimated flag", () => {
		const open = parsed(
			answerCostExplorer(FIXTURE_ITEMS, request("REGION"), { estimatedFrom: "2026-03-01" })
				.ResultsByTime,
		)
		const estimated = Arr.dedupe(
			Arr.map(
				Arr.filter(serviceRows(open, ACCOUNT, []), (row) => row.estimated),
				(row) => row.day,
			),
		)
		assert.deepStrictEqual(estimated, ["2026-03-01"])
	})
})

describe("parseGroups", () => {
	it("reads a usage of mixed units as no quantity", () => {
		const [row] = usageRows(
			parsed([
				oneGroup({
					UnblendedCost: usd("0.31"),
					AmortizedCost: usd("0.31"),
					UsageQuantity: { Amount: "22", Unit: "N/A" },
				}),
			]),
			ACCOUNT,
			"eu-central-1",
		)
		assert.strictEqual(row?.consumedQuantity, 0)
		assert.strictEqual(row?.consumedUnit, "")
		assert.strictEqual(row?.billedCost, 0.31)
		assert.isTrue(row?.estimated)
	})

	it("keeps a row that only amortized cost gives a value", () => {
		const rows = usageRows(
			parsed([
				oneGroup({
					UnblendedCost: usd("0"),
					AmortizedCost: usd("2.5"),
					UsageQuantity: { Amount: "24", Unit: "Hrs" },
				}),
			]),
			ACCOUNT,
			"eu-central-1",
		)
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.billedCost, row.effectiveCost, row.consumedQuantity]),
			[[0, 2.5, 24]],
		)
	})

	it("rejects an amount that is not a finite number", () => {
		Arr.forEach(["NaN", "Infinity", "-Infinity", "twelve", "", " "], (bad) => {
			assert.isTrue(
				Result.isFailure(
					parseGroups([oneGroup({ UnblendedCost: usd(bad), AmortizedCost: usd("1") })]),
				),
				`UnblendedCost "${bad}"`,
			)
			assert.isTrue(
				Result.isFailure(
					parseGroups([oneGroup({ UnblendedCost: usd("1"), AmortizedCost: usd(bad) })]),
				),
				`AmortizedCost "${bad}"`,
			)
		})
		assert.isTrue(
			Result.isFailure(
				parseGroups([
					oneGroup({
						UnblendedCost: usd("1"),
						AmortizedCost: usd("1"),
						UsageQuantity: { Amount: "NaN", Unit: "Hrs" },
					}),
				]),
			),
		)
	})

	it("rejects a group without a cost metric or without both keys", () => {
		assert.isTrue(Result.isFailure(parseGroups([oneGroup({ UnblendedCost: usd("1") })])))
		assert.isTrue(
			Result.isFailure(
				parseGroups([
					{
						TimePeriod: { Start: "2026-03-01", End: "2026-03-02" },
						Groups: [
							{
								Keys: ["Invented Service"],
								Metrics: { UnblendedCost: usd("1"), AmortizedCost: usd("1") },
							},
						],
					},
				]),
			),
		)
	})
})

describe("serviceCategoryOf", () => {
	it("sorts AWS service names into categories, and the unknown into Other", () => {
		assert.deepStrictEqual(
			Arr.map(
				[
					"Amazon Elastic Compute Cloud - Compute",
					"EC2 - Other",
					"Amazon Simple Storage Service",
					"Amazon Relational Database Service",
					"Amazon Virtual Private Cloud",
					"AmazonCloudWatch",
					"AWS Key Management Service",
					"Amazon Bedrock",
					"Tax",
					"Invented Service",
				],
				serviceCategoryOf,
			),
			[
				"Compute",
				"Compute",
				"Storage",
				"Databases",
				"Networking",
				"Management and Governance",
				"Security",
				"AI and Machine Learning",
				"Other",
				"Other",
			],
		)
	})
})
