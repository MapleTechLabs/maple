// Anthropic's cost report as `cost_daily` rows: one per day, model or tool, cost line and workspace.
import { Array as Arr, Option, Record as Rec, Result, String as Str } from "effect"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"
import type { CostBucket, CostResult } from "./anthropic-cost-api"

const CATEGORY = "AI and Machine Learning"

/** What a cost line with no model is for, by its `cost_type`. */
const TOOL_SERVICES = new Map([
	["web_search", "Web search"],
	["code_execution", "Code execution"],
	["session_usage", "Managed Agents sessions"],
])

/** Fields that tell cost lines of one key apart without being part of it, kept as tags. */
const TAG_FIELDS = ["service_tier", "token_type", "context_window", "speed", "inference_geo"] as const

const dayOf = (timestamp: string): string => Str.slice(0, 10)(timestamp)

// NUL cannot be in a day or a name, so the key keeps the parts apart.
const keyOf = (parts: ReadonlyArray<string>): string => Arr.join(parts, "\u0000")

/** A model's lines are named by the model, which the Cost page shows with Anthropic's logo. */
const serviceOf = (result: CostResult): string => {
	const model = result.model ?? null
	if (model !== null) return `anthropic/${model}`
	// Any other charge goes under one name the Cost page knows as Anthropic's; its line is the usage type.
	return TOOL_SERVICES.get(result.cost_type ?? "") ?? "Anthropic API"
}

const tagsOf = (result: CostResult): Record<string, string> =>
	Rec.fromEntries(
		Arr.flatMap(TAG_FIELDS, (field): ReadonlyArray<[string, string]> => {
			const value = result[field] ?? null
			return value === null ? [] : [[field, value]]
		}),
	)

/** Tags every row of a group agrees on: a tag the rows disagree on describes none of the sum. */
const sharedTags = (
	first: Readonly<Record<string, string>>,
	rest: ReadonlyArray<Readonly<Record<string, string>>>,
): Record<string, string> => Rec.filter(first, (value, key) => Arr.every(rest, (tags) => tags[key] === value))

/** An amount that is not a decimal number: storing it as anything would invent or drop spend. */
const isAmount = (amount: string): boolean => Str.trim(amount) !== "" && Number.isFinite(Number(amount))

/**
 * The window's rows, or the first amount that is not a number. Lines of one key (day, service,
 * usage type, region, workspace, currency) are summed: the warehouse reads by that key, so two rows would
 * count once. Days from `openDay` on can still change.
 */
export const toCostRows = (
	buckets: ReadonlyArray<CostBucket>,
	accountId: string,
	window: CostPullWindow,
	openDay: string,
): Result.Result<ReadonlyArray<CostPullRow>, string> => {
	const lines = Arr.flatMap(buckets, (bucket) => {
		const day = dayOf(bucket.starting_at)
		return day >= window.startDay && day <= window.endDay
			? Arr.map(bucket.results, (result) => ({ day, result }))
			: []
	})
	const bad = Arr.findFirst(lines, ({ result }) => !isAmount(result.amount))
	if (Option.isSome(bad)) return Result.fail(bad.value.result.amount)
	const rows = Arr.map(lines, ({ day, result }): CostPullRow => {
		// Anthropic reports cents.
		const cost = Number(result.amount) / 100
		return {
			day,
			accountId,
			cloudService: serviceOf(result),
			serviceCategory: CATEGORY,
			usageType: result.description ?? result.cost_type ?? "",
			// The inference geography is a price tier, not a place the Cost page can name: it is a tag.
			region: "global",
			resourceId: result.workspace_id ?? "default",
			resourceType: "workspace",
			serviceName: "",
			chargeCategory: "usage",
			basis: "billed",
			currency: Str.toUpperCase(result.currency ?? "USD"),
			billedCost: cost,
			effectiveCost: cost,
			listCost: cost,
			consumedQuantity: 0,
			consumedUnit: "",
			tags: tagsOf(result),
			estimated: day >= openDay,
		}
	})
	const groups = Arr.groupBy(rows, (row) =>
		keyOf([
			row.day,
			row.cloudService,
			row.usageType,
			row.region,
			row.resourceId,
			row.chargeCategory,
			row.currency,
		]),
	)
	return Result.succeed(
		Arr.map(Rec.values(groups), (group): CostPullRow => {
			const [first, ...rest] = group
			const sum = (of: (row: CostPullRow) => number) =>
				Arr.reduce(group, 0, (total, row) => total + of(row))
			return {
				...first,
				billedCost: sum((row) => row.billedCost),
				effectiveCost: sum((row) => row.effectiveCost),
				listCost: sum((row) => row.listCost),
				tags: sharedTags(
					first.tags,
					Arr.map(rest, (row) => row.tags),
				),
			}
		}),
	)
}
