import type { IconName } from "@maple/views/ui/icon"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { Array as Arr, Number as Num, Option, Order, Record as Rec } from "effect"

// Invented spend for the cost islands: one made-up org, 30 UTC days ending on a fixed date, read
// the way the Cost page reads its API. Nothing here is a customer's bill.

export const DIMENSIONS = ["cloud_service", "provider", "service_category", "region"] as const
export type Dimension = (typeof DIMENSIONS)[number]

/** Each dimension's name in the control, the chips and the table, as the Cost page words them. */
export const DIMENSION_TEXT = {
	cloud_service: { label: "Service", noun: "service" },
	provider: { label: "Provider", noun: "provider" },
	service_category: { label: "Category", noun: "category" },
	region: { label: "Region", noun: "region" },
} as const satisfies Record<Dimension, Readonly<{ label: string; noun: string }>>

export type Filter = Readonly<{ dimension: Dimension; value: string }>
export type SortBy = "cost" | "change"
export type Mark = Readonly<{ icon: IconName; className?: string }>

const PROVIDERS = {
	aws: { name: "AWS", mark: { icon: "AwsIcon", className: "text-foreground" } },
	vercel: { name: "Vercel", mark: { icon: "VercelIcon", className: "text-foreground" } },
	cloudflare: { name: "Cloudflare", mark: { icon: "CloudflareBrandIcon" } },
	planetscale: { name: "PlanetScale", mark: { icon: "PlanetScaleIcon", className: "text-foreground" } },
	github: { name: "GitHub", mark: { icon: "GithubIcon", className: "text-foreground" } },
	anthropic: { name: "Anthropic", mark: { icon: "AnthropicIcon", className: "text-foreground" } },
	openai: { name: "OpenAI", mark: { icon: "OpenAiIcon", className: "text-foreground" } },
} as const satisfies Record<string, Readonly<{ name: string; mark: Mark }>>
type Provider = keyof typeof PROVIDERS

const CATEGORY_ICONS = {
	"AI and Machine Learning": "SparkleIcon",
	Databases: "DatabaseIcon",
	Storage: "BoxArchiveIcon",
	Networking: "NetworkNodesIcon",
	"Management and Governance": "GaugeIcon",
	"Developer Tools": "CodeIcon",
	Compute: "MicrochipIcon",
} as const satisfies Record<string, IconName>

const isCategory = (key: string): key is keyof typeof CATEGORY_ICONS =>
	Rec.has<string, IconName>(CATEGORY_ICONS, key)

/** `daily` is the charge per day on the last day; `drift` how much it grew or shrank over the window. */
type Line = Readonly<Record<Dimension, string> & { daily: number; drift: number }>

const line = (
	provider: Provider,
	cloud_service: string,
	service_category: string,
	region: string,
	daily: number,
	drift: number,
): Line => ({ provider, cloud_service, service_category, region, daily, drift })

const LINES: ReadonlyArray<Line> = [
	line("aws", "Amazon Elastic Compute Cloud", "Compute", "us-east-1", 61.2, 0.18),
	line("aws", "Amazon Elastic Compute Cloud", "Compute", "eu-central-1", 22.4, -0.06),
	line("aws", "Amazon Elastic Container Service", "Compute", "us-east-1", 34.9, 0.31),
	line("aws", "AWS Lambda", "Compute", "us-east-1", 4.1, 0.05),
	line("aws", "Amazon Relational Database Service", "Databases", "us-east-1", 47.3, 0.02),
	line("aws", "Amazon Relational Database Service", "Databases", "eu-central-1", 12.8, 0),
	line("aws", "Amazon ElastiCache", "Databases", "us-east-1", 9.6, -0.22),
	line("aws", "Amazon Simple Storage Service", "Storage", "us-east-1", 18.7, 0.09),
	line("aws", "Amazon Simple Storage Service", "Storage", "eu-central-1", 6.3, 0.04),
	line("aws", "Amazon CloudWatch", "Management and Governance", "us-east-1", 8.8, -0.35),
	line("aws", "AWS Data Transfer", "Networking", "us-east-1", 15.4, 0.4),
	line("anthropic", "anthropic/claude-opus-5-5", "AI and Machine Learning", "global", 32.7, 0.3),
	line("anthropic", "anthropic/claude-haiku-5-5", "AI and Machine Learning", "global", 1.9, -0.05),
	line("openai", "openai/gpt-5", "AI and Machine Learning", "global", 19.5, 0.12),
	line("openai", "openai/text-embedding-3-large", "AI and Machine Learning", "global", 0.9, 0),
	line("vercel", "Function Duration", "Compute", "iad1", 9.4, 0.2),
	line("vercel", "Function Duration", "Compute", "fra1", 3.1, 0.05),
	line("vercel", "Fast Data Transfer", "Networking", "global", 6.7, 0.12),
	line("cloudflare", "Workers", "Compute", "global", 9.4, 0.25),
	line("cloudflare", "Durable Objects", "Compute", "global", 5.1, 0.12),
	line("cloudflare", "R2", "Storage", "global", 3.6, 0.05),
	line("planetscale", "orders", "Databases", "global", 11.4, 0.02),
	line("planetscale", "search", "Databases", "global", 1.3, 0),
	line("github", "Actions", "Developer Tools", "global", 10.1, 0.25),
	line("github", "Copilot", "Developer Tools", "global", 6.3, 0),
]

export const DAYS = 30
/** The last days of the window, which the provider can still restate: drawn as lighter bars. */
export const ESTIMATED_DAYS = 2
export const CURRENCY = "USD"
const LAST_DAY_MS = Date.UTC(2026, 10, 16)
/** The clock the chart's in-flight tail is judged against. */
export const NOW_MS = LAST_DAY_MS + 14.5 * 3_600_000
const DAY_MS = 86_400_000
/** The series the chart draws on their own; the rest fold into "Other", as the API folds them. */
const MAX_SERIES = 7
const OTHER = "Other"
const MUTED = "var(--muted-foreground)"

const DAY_TEXT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

/** The window as a statement heads it: "Oct 18 to Nov 16". */
export const WINDOW_TEXT = `${DAY_TEXT.format(LAST_DAY_MS - (DAYS - 1) * DAY_MS)} to ${DAY_TEXT.format(LAST_DAY_MS)}`

const dayAt = (offset: number): string => new Date(LAST_DAY_MS - offset * DAY_MS).toISOString().slice(0, 10)

/** A line's charge `offset` days ago: its level then, with a weekly ripple so the bars are not flat. */
const chargeAt = (entry: Line, index: number, offset: number): number => {
	const level = entry.daily * (1 - (entry.drift * offset) / 30)
	const ripple = 1 + 0.09 * Math.sin(offset * 0.9 + index * 1.7)
	return Math.max(0, Math.round(level * ripple * 100) / 100)
}

const round = (value: number): number => Math.round(value * 100) / 100

const matches = (entry: Line, filters: ReadonlyArray<Filter>): boolean =>
	Arr.every(DIMENSIONS, (dimension) => {
		const values = Arr.flatMap(filters, (filter) =>
			filter.dimension === dimension ? [filter.value] : [],
		)
		return values.length === 0 || Arr.contains(values, entry[dimension])
	})

const isProvider = (key: string): key is Provider => Rec.has<string, unknown>(PROVIDERS, key)

/** A key as the page shows it: a provider by its name, anything else by the provider's own text. */
export const keyLabel = (dimension: Dimension, key: string): string =>
	dimension === "provider" && isProvider(key) ? PROVIDERS[key].name : key

const glyph = (icon: IconName): Mark => ({ icon, className: "text-muted-foreground" })

/** The mark beside a key: the logo of the one provider that bills it, else its kind's glyph. */
export const keyMark = (dimension: Dimension, key: string): Mark => {
	if (dimension === "service_category") return glyph(isCategory(key) ? CATEGORY_ICONS[key] : "CubeIcon")
	const providers = Arr.dedupe(
		Arr.flatMap(LINES, (entry) =>
			entry[dimension] === key && isProvider(entry.provider) ? [entry.provider] : [],
		),
	)
	const [only, ...others] = providers
	return only === undefined || others.length > 0
		? glyph(dimension === "region" ? "GlobeIcon" : "CubeIcon")
		: PROVIDERS[only].mark
}

/** Where a row's click goes next: the grouping that splits it further, skipping one already narrowed. */
const DRILL_ORDER = {
	cloud_service: ["region", "provider"],
	provider: ["cloud_service", "region"],
	service_category: ["cloud_service", "provider", "region"],
	region: ["cloud_service", "provider"],
} as const satisfies Record<Dimension, ReadonlyArray<Dimension>>

export const drillTarget = (dimension: Dimension, filters: ReadonlyArray<Filter>): Dimension =>
	Arr.findFirst(
		DRILL_ORDER[dimension],
		(next) => !Arr.some(filters, (filter) => filter.dimension === next),
	).pipe(Option.getOrElse(() => dimension))

export type BreakdownRow = Readonly<{
	key: string
	label: string
	cost: number
	previousCost: number
	/** The chart's colour for a key it draws on its own; undefined for one folded into "Other". */
	color: string | undefined
	mark: Mark
}>

export type ChartRow = Readonly<Record<string, string | number | boolean>>

export type CostView = Readonly<{
	cost: number
	previousCost: number
	rows: ReadonlyArray<BreakdownRow>
	/** One row per UTC day: a column per series, largest first, "Other" last. */
	chartRows: ReadonlyArray<ChartRow>
	/** Each series' logo in the legend, by the name it plots under. */
	seriesMarks: Readonly<Record<string, Mark>>
	/** Each series' colour, by the name it plots under, for the static preview. */
	seriesColors: ReadonlyArray<readonly [string, string]>
}>

const byCost = Order.mapInput(Order.flip(Num.Order), (row: { cost: number }) => row.cost)
const byChange = Order.mapInput(
	Order.flip(Num.Order),
	(row: { cost: number; previousCost: number }) => row.cost - row.previousCost,
)

const compute = (groupBy: Dimension, filters: ReadonlyArray<Filter>, sort: SortBy): CostView => {
	const windowed = Arr.flatMap(LINES, (entry, index) =>
		matches(entry, filters)
			? [
					{
						key: entry[groupBy],
						current: Arr.makeBy(DAYS, (day) => chargeAt(entry, index, DAYS - 1 - day)),
						previous: Num.sumAll(
							Arr.makeBy(DAYS, (day) => chargeAt(entry, index, 2 * DAYS - 1 - day)),
						),
					},
				]
			: [],
	)
	const groups = Arr.map(Rec.toEntries(Arr.groupBy(windowed, (entry) => entry.key)), ([key, entries]) => ({
		key,
		points: Arr.makeBy(DAYS, (day) => round(Num.sumAll(Arr.map(entries, (e) => e.current[day] ?? 0)))),
		cost: round(Num.sumAll(Arr.flatMap(entries, (entry) => entry.current))),
		previousCost: round(Num.sumAll(Arr.map(entries, (entry) => entry.previous))),
	}))
	const largestFirst = Arr.sort(groups, byCost)
	// A tail of one key is drawn as itself: an "Other" that holds one thing says less than its name.
	const shown = largestFirst.length === MAX_SERIES + 1 ? MAX_SERIES + 1 : MAX_SERIES
	const head = Arr.take(largestFirst, shown)
	const tail = Arr.drop(largestFirst, shown)
	const series = [
		...Arr.map(head, (group) => ({ name: keyLabel(groupBy, group.key), points: group.points })),
		...(tail.length === 0
			? []
			: [
					{
						name: OTHER,
						points: Arr.makeBy(DAYS, (day) =>
							round(Num.sumAll(Arr.map(tail, (group) => group.points[day] ?? 0))),
						),
					},
				]),
	]
	// The same name set the bar chart resolves, "Other" included: a colour depends on the whole set.
	const colors = resolveSeriesColors(Arr.map(series, (entry) => entry.name))
	return {
		cost: round(Num.sumAll(Arr.map(groups, (group) => group.cost))),
		previousCost: round(Num.sumAll(Arr.map(groups, (group) => group.previousCost))),
		rows: Arr.map(Arr.sort(groups, sort === "cost" ? byCost : byChange), (group) => ({
			key: group.key,
			label: keyLabel(groupBy, group.key),
			cost: group.cost,
			previousCost: group.previousCost,
			color: Arr.some(head, (entry) => entry.key === group.key)
				? colors.get(keyLabel(groupBy, group.key))
				: undefined,
			mark: keyMark(groupBy, group.key),
		})),
		chartRows: Arr.makeBy(DAYS, (day) => ({
			bucket: `${dayAt(DAYS - 1 - day)}T00:00:00Z`,
			...Rec.fromEntries(Arr.map(series, (entry) => [entry.name, entry.points[day] ?? 0] as const)),
			...(day >= DAYS - ESTIMATED_DAYS ? { partial: true } : undefined),
		})),
		seriesMarks: Rec.fromEntries(
			Arr.map(head, (group) => [keyLabel(groupBy, group.key), keyMark(groupBy, group.key)] as const),
		),
		// "Other" is drawn muted, as the bar chart draws it.
		seriesColors: Arr.map(
			series,
			(entry) =>
				[entry.name, entry.name === OTHER ? MUTED : (colors.get(entry.name) ?? MUTED)] as const,
		),
	}
}

const views = new Map<string, CostView>()

/**
 * The page's reads for one grouping, filter set and order. Kept per input: the chart caches on its
 * rows' identity, so a hover must re-render over the same array.
 */
export const costView = (groupBy: Dimension, filters: ReadonlyArray<Filter>, sort: SortBy): CostView => {
	const key = JSON.stringify([groupBy, filters, sort])
	const cached = views.get(key)
	if (cached !== undefined) return cached
	const view = compute(groupBy, filters, sort)
	views.set(key, view)
	return view
}

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: CURRENCY })

/** Under half a cent either way is no amount: it reads as zero, never as "-$0.00". */
const isNegligible = (amount: number): boolean => Math.abs(amount) < 0.005

export const formatMoney = (amount: number): string => MONEY.format(isNegligible(amount) ? 0 : amount)

/** A change with its sign; under half a cent either way reads as zero, unsigned. */
export const formatMoneyChange = (amount: number): string =>
	isNegligible(amount) ? formatMoney(0) : amount > 0 ? `+${formatMoney(amount)}` : formatMoney(amount)
