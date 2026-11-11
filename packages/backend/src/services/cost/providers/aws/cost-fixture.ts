/**
 * An invented account for the cost tests: two regions with real spend, one with fractions of a
 * cent, a global charge, tax with no region and a free usage type. No figure here is anyone's bill.
 */
import { Array as Arr } from "effect"
import type { FakeCostItem } from "./fake-cost-explorer"

export const FIXTURE_WINDOW = { startDay: "2026-02-27", endDay: "2026-03-01" }
export const FIXTURE_DAYS = ["2026-02-27", "2026-02-28", "2026-03-01"]

const COMPUTE = "Amazon Elastic Compute Cloud - Compute"
const STORAGE = "Amazon Simple Storage Service"

const daily = (day: string, scale: number): ReadonlyArray<FakeCostItem> => [
	{
		day,
		service: COMPUTE,
		region: "eu-central-1",
		usageType: "EUC1-BoxUsage:m7g.large",
		cost: 4.8 * scale,
		// A commitment covers part of it: what it costs differs from what the day billed.
		amortized: 3.6 * scale,
		quantity: 48,
		unit: "Hrs",
	},
	{
		day,
		service: STORAGE,
		region: "eu-central-1",
		usageType: "EUC1-TimedStorage-ByteHrs",
		cost: 0.75 * scale,
		quantity: 32.5,
		unit: "GB-Mo",
	},
	{
		day,
		service: STORAGE,
		region: "eu-central-1",
		usageType: "EUC1-Requests-Tier1",
		cost: 0.05 * scale,
		quantity: 10000,
		unit: "Requests",
	},
	{
		day,
		service: "AWS Key Management Service",
		region: "eu-central-1",
		usageType: "EUC1-KMS-Requests",
		cost: 0,
		quantity: 22,
		unit: "Requests",
	},
	{
		day,
		service: "AWS Lambda",
		region: "us-east-1",
		usageType: "Lambda-GB-Second",
		cost: 1.25 * scale,
		quantity: 75000,
		unit: "Lambda-GB-Second",
	},
	{
		day,
		service: "AWS Lambda",
		region: "us-east-1",
		usageType: "Request",
		cost: 0.2 * scale,
		quantity: 1000000,
		unit: "Requests",
	},
	{
		day,
		service: "AWS CloudTrail",
		region: "ap-southeast-2",
		usageType: "APS2-PaidEventsRecorded",
		cost: 0.004,
		quantity: 200,
		unit: "Events",
	},
]

export const FIXTURE_ITEMS: ReadonlyArray<FakeCostItem> = [
	...Arr.flatMap(FIXTURE_DAYS, (day, index) => daily(day, 1 + index / 4)),
	{
		day: "2026-02-28",
		service: "Amazon Route 53",
		region: "global",
		usageType: "HostedZone",
		cost: 0.5,
		quantity: 1,
		unit: "HostedZone",
	},
	{
		day: "2026-03-01",
		service: "Tax",
		region: "",
		usageType: "",
		cost: 1.9,
		quantity: 0,
		unit: "",
	},
]

/** The regions of the fixture that hold enough to be read by usage type. */
export const FIXTURE_DETAILED = ["eu-central-1", "global", "us-east-1"]
