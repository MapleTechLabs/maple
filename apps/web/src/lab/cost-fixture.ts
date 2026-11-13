import { CostProvider } from "@maple/domain/cost"
import {
	CostBreakdownResponse,
	type CostBreakdownSortBy,
	type CostFilters,
	CostSourcesResponse,
	CostTimeseriesResponse,
	CostTotalsResponse,
	GithubCostInstallations,
} from "@maple/domain/http"
import { Array as Arr, Number as Num, Option, Order, Record as Rec, Schema, String as Str } from "effect"
import type { CostGroupBy } from "../page/cost/derive"

// Synthetic cost for `/lab/cost`: invented services, regions and amounts on one made-up account.
// Nothing here is read by the product.

export const LAB_ACCOUNT = "123456789012"
/** The lab's "today"; its last two days are still open to a restatement. */
export const LAB_TODAY = "2026-11-10"
const LAB_TODAY_MS = Date.UTC(2026, 10, 10)
export const LAB_NOW_MS = LAB_TODAY_MS + 14.5 * 3_600_000
const ESTIMATED_DAYS = 2
const DAY_MS = 86_400_000

type Line = Readonly<Record<CostGroupBy | "usage_type", string> & { daily: number; drift: number }>

const line = (
	cloud_service: string,
	service_category: string,
	region: string,
	usage_type: string,
	daily: number,
	drift: number,
): Line => ({
	cloud_service,
	provider: "aws",
	service_category,
	region,
	usage_type,
	resource: "",
	account: LAB_ACCOUNT,
	daily,
	drift,
})

/** A saved OpenRouter key, as OpenRouter masks it. */
export const LAB_OPENROUTER_KEY = "sk-or-v1-4f2...c81"
/** The OpenRouter account the lab's source reads: a personal account's user id. */
const LAB_OPENROUTER_ACCOUNT = "user_2labExampleAccount0000000000"

const modelLine = (model: string, servedBy: string, daily: number, drift: number): Line => ({
	cloud_service: model,
	provider: "openrouter",
	service_category: "AI and Machine Learning",
	region: "global",
	usage_type: servedBy,
	resource: "",
	account: LAB_OPENROUTER_ACCOUNT,
	daily,
	drift,
})

/** The GitHub organization the lab's source reads, and the installation it reads through. */
const LAB_GITHUB_ORG = "example-org"
const LAB_GITHUB_INSTALLATION = "0190f2b3-0000-4000-8000-00000000e061"
/** A second organization the lab's reader can add. */
const LAB_GITHUB_OTHER_ORG = "example-labs"
const LAB_GITHUB_OTHER_INSTALLATION = "0190f2b3-0000-4000-8000-00000000e062"

/** `repository` is the row's resource; a seat product names none. */
const githubLine = (
	product: string,
	sku: string,
	repository: string,
	daily: number,
	drift: number,
): Line => ({
	cloud_service: product,
	provider: "github",
	service_category: "Developer Tools",
	region: "global",
	usage_type: sku,
	resource: repository,
	account: LAB_GITHUB_ORG,
	daily,
	drift,
})

/** The Vercel team the lab's source reads: its id is the account, its slug what the page shows. */
export const LAB_VERCEL_TEAM = {
	id: "team_labExample000000000000",
	name: "Example Team",
	slug: "example-team",
}

const productLine = (
	product: string,
	category: string,
	region: string,
	sku: string,
	project: string,
	daily: number,
	drift: number,
): Line => ({
	cloud_service: product,
	provider: "vercel",
	service_category: category,
	region,
	usage_type: sku,
	resource: project,
	account: LAB_VERCEL_TEAM.id,
	daily,
	drift,
})

/** `daily` is the charge per day today; `drift` how much it grew or shrank over the last 30 days. */
const LINES: ReadonlyArray<Line> = [
	line("Example Compute", "Compute", "north-1", "north-1:instance-hours", 61.2, 0.18),
	line("Example Compute", "Compute", "west-2", "west-2:instance-hours", 22.4, -0.06),
	line("Example Containers", "Compute", "north-1", "north-1:task-hours", 34.9, 0.31),
	line("Example Functions", "Compute", "north-1", "north-1:invocations", 4.1, 0.05),
	line("Example Database", "Databases", "north-1", "north-1:db-hours", 47.3, 0.02),
	line("Example Database", "Databases", "west-2", "west-2:db-hours", 12.8, 0.0),
	line("Example Cache", "Databases", "north-1", "north-1:node-hours", 9.6, -0.22),
	line("Example Object Store", "Storage", "north-1", "north-1:gb-months", 18.7, 0.09),
	line("Example Object Store", "Storage", "west-2", "west-2:gb-months", 6.3, 0.04),
	line("Example Block Store", "Storage", "north-1", "north-1:volume-gb", 7.9, 0.01),
	line("Example Network", "Networking", "north-1", "north-1:data-out-gb", 15.4, 0.4),
	line("Example Load Balancer", "Networking", "north-1", "north-1:lb-hours", 5.2, 0.0),
	line("Example Queue", "Integration", "north-1", "north-1:requests", 2.6, -0.1),
	line("Example Registry", "Storage", "south-3", "south-3:gb-months", 1.4, 0.03),
	line("Example Logs", "Management", "north-1", "north-1:ingested-gb", 8.8, -0.35),
	// A charge with no region, the way a support plan is billed.
	line("Example Support", "", "", "support-plan", 11.0, 0.0),
	modelLine("example/large-model", "Example Labs", 38.5, 0.42),
	modelLine("example/large-model", "Example Cloud", 6.2, 0.1),
	modelLine("example/fast-model", "Example Inference", 12.9, -0.15),
	modelLine("example/embedding-model", "Example Labs", 1.8, 0.0),
	githubLine("Actions", "Actions Linux", "example-api", 9.4, 0.25),
	githubLine("Actions", "Actions storage", "example-site", 0.7, 0.05),
	githubLine("Copilot", "Copilot Business", "", 6.3, 0.0),
	githubLine("Packages", "Packages storage", "example-api", 0.4, -0.1),
	productLine("Example Function Duration", "Compute", "iad1", "function-duration", "example-web", 9.4, 0.2),
	productLine(
		"Example Function Duration",
		"Compute",
		"fra1",
		"function-duration",
		"example-docs",
		3.1,
		0.05,
	),
	productLine("Example Data Transfer", "Networking", "global", "data-transfer", "example-web", 6.7, 0.12),
	productLine(
		"Example Image Optimization",
		"Web",
		"global",
		"image-optimization",
		"example-docs",
		2.2,
		-0.08,
	),
	// The plan's monthly fee, as Vercel spreads it over the days: it belongs to no project.
	productLine("Example Pro Plan", "Other", "global", "", "", 0.67, 0.0),
]

/** The day `offset` days before the lab's today, as `YYYY-MM-DD`. */
const dayAt = (offset: number): string =>
	Str.slice(0, 10)(new Date(LAB_TODAY_MS - offset * DAY_MS).toISOString())

/** A line's charge `offset` days ago: its level then, with a weekly ripple so the bars are not flat. */
const chargeAt = (entry: Line, index: number, offset: number): number => {
	const level = entry.daily * (1 - (entry.drift * offset) / 30)
	const ripple = 1 + 0.09 * Math.sin(offset * 0.9 + index * 1.7)
	return Math.max(0, Math.round(level * ripple * 100) / 100)
}

const matches = (entry: Line, filters: CostFilters | undefined): boolean =>
	Arr.every(
		[
			"cloud_service",
			"provider",
			"service_category",
			"region",
			"usage_type",
			"resource",
			"account",
		] as const,
		(dimension) => {
			const values = filters?.[dimension] ?? []
			return values.length === 0 || Arr.contains(values, entry[dimension])
		},
	)

type Request = Readonly<{
	days: number
	filters: CostFilters | undefined
	/** Providers the lab's reader removed: their lines are in no read, whatever the filters say. */
	without?: ReadonlyArray<CostProvider>
}>

/** Each matching line with its charge on every day of the window (oldest first) and of the period before. */
const windowOf = (request: Request) =>
	Arr.flatMap(LINES, (entry, index) =>
		matches(entry, request.filters) && !Arr.contains(request.without ?? [], entry.provider)
			? [
					{
						entry,
						current: Arr.makeBy(request.days, (day) =>
							chargeAt(entry, index, request.days - 1 - day),
						),
						previous: Arr.makeBy(request.days, (day) =>
							chargeAt(entry, index, 2 * request.days - 1 - day),
						),
					},
				]
			: [],
	)

const round = (value: number): number => Math.round(value * 100) / 100

const decodeTotals = Schema.decodeSync(CostTotalsResponse)
const decodeTimeseries = Schema.decodeSync(CostTimeseriesResponse)
const decodeBreakdown = Schema.decodeSync(CostBreakdownResponse)
const decodeSources = Schema.decodeSync(CostSourcesResponse)

export const labTotals = (request: Request): CostTotalsResponse => {
	const lines = windowOf(request)
	return decodeTotals({
		cost: round(Num.sumAll(Arr.flatMap(lines, (entry) => entry.current))),
		previousCost: round(Num.sumAll(Arr.flatMap(lines, (entry) => entry.previous))),
		estimatedDays: lines.length === 0 ? 0 : Math.min(ESTIMATED_DAYS, request.days),
		currency: lines.length === 0 ? "" : "USD",
		currencies: lines.length === 0 ? [] : ["USD"],
		days: request.days,
	})
}

type Grouped = Readonly<{ key: string; current: ReadonlyArray<number>; previous: ReadonlyArray<number> }>

const sumByDay = (rows: ReadonlyArray<ReadonlyArray<number>>, days: number): ReadonlyArray<number> =>
	Arr.makeBy(days, (day) => round(Num.sumAll(Arr.map(rows, (row) => row[day] ?? 0))))

const grouped = (request: Request, groupBy: CostGroupBy): ReadonlyArray<Grouped> =>
	Arr.map(
		Rec.toEntries(Arr.groupBy(windowOf(request), (entry) => entry.entry[groupBy])),
		([key, lines]) => ({
			key,
			current: sumByDay(
				Arr.map(lines, (entry) => entry.current),
				request.days,
			),
			previous: sumByDay(
				Arr.map(lines, (entry) => entry.previous),
				request.days,
			),
		}),
	)

const byCost = Order.flip(Order.mapInput(Order.Number, (group: Grouped) => Num.sumAll(group.current)))

export const labTimeseries = (
	request: Request & { groupBy: CostGroupBy; limit: number },
): CostTimeseriesResponse => {
	const ranked = Arr.sort(grouped(request, request.groupBy), byCost)
	const tail = Arr.drop(ranked, request.limit)
	const series = (key: string, other: boolean, points: ReadonlyArray<number>) => ({
		key,
		other,
		total: round(Num.sumAll(points)),
		points,
	})
	return decodeTimeseries({
		currency: "USD",
		days: Arr.makeBy(request.days, (day) => dayAt(request.days - 1 - day)),
		series: [
			...Arr.map(Arr.take(ranked, request.limit), (group) => series(group.key, false, group.current)),
			...(tail.length === 0
				? []
				: [
						series(
							"__other__",
							true,
							sumByDay(
								Arr.map(tail, (group) => group.current),
								request.days,
							),
						),
					]),
		],
		estimatedFrom: ranked.length === 0 ? null : dayAt(ESTIMATED_DAYS - 1),
	})
}

export const labBreakdown = (
	request: Request & { groupBy: CostGroupBy; sortBy: CostBreakdownSortBy },
): CostBreakdownResponse => {
	const rows = Arr.map(grouped(request, request.groupBy), (group) => ({
		key: group.key,
		cost: round(Num.sumAll(group.current)),
		previousCost: round(Num.sumAll(group.previous)),
	}))
	const order =
		request.sortBy === "cost"
			? Order.flip(Order.mapInput(Order.Number, (row: (typeof rows)[number]) => row.cost))
			: Order.flip(
					Order.mapInput(Order.Number, (row: (typeof rows)[number]) =>
						Math.abs(row.cost - row.previousCost),
					),
				)
	return decodeBreakdown({ currency: "USD", rows: Arr.sort(rows, order) })
}

type SourceWire = (typeof CostSourcesResponse.Encoded)["sources"][number]

const source = (over: Partial<SourceWire>): SourceWire => ({
	id: "0190f2b3-0000-7000-8000-00000000c057",
	provider: "aws",
	connectionRef: "0190f2b3-0000-7000-8000-00000000a057",
	accountId: LAB_ACCOUNT,
	status: "ok",
	watermarkDate: dayAt(1),
	backfillDate: "2025-10-01",
	historyComplete: true,
	lastSyncedAt: LAB_NOW_MS - 47 * 60_000,
	lastError: null,
	lastErrorReason: null,
	requestsThisMonth: 86,
	...over,
})

/** The OpenRouter source: four weeks of history, which is all the provider keeps, and no billed requests. */
const openRouterSource = source({
	id: "0190f2b3-0000-7000-8000-00000000c060",
	provider: "openrouter",
	connectionRef: "0190f2b3-0000-7000-8000-00000000a060",
	accountId: LAB_OPENROUTER_ACCOUNT,
	backfillDate: dayAt(29),
	lastSyncedAt: LAB_NOW_MS - 3 * 3_600_000,
	requestsThisMonth: 0,
})

/** The GitHub source: this month and the three before it, and no billed requests. */
const githubSource = source({
	id: "0190f2b3-0000-7000-8000-00000000c061",
	provider: "github",
	connectionRef: LAB_GITHUB_INSTALLATION,
	accountId: LAB_GITHUB_ORG,
	backfillDate: "2026-08-01",
	lastSyncedAt: LAB_NOW_MS - 5 * 3_600_000,
	requestsThisMonth: 0,
})

/** The Vercel source: eleven months of history, all one request serves, and no billed requests. */
const vercelSource = source({
	id: "0190f2b3-0000-7000-8000-00000000c063",
	provider: "vercel",
	connectionRef: "0190f2b3-0000-7000-8000-00000000a063",
	accountId: LAB_VERCEL_TEAM.id,
	accountName: LAB_VERCEL_TEAM.slug,
	backfillDate: "2025-12-01",
	lastSyncedAt: LAB_NOW_MS - 2 * 3_600_000,
	requestsThisMonth: 0,
})

/** A source that was just added: it waits for its first sync. */
const justAdded = (entry: SourceWire): SourceWire => ({
	...entry,
	status: "pending",
	watermarkDate: null,
	backfillDate: null,
	historyComplete: false,
	lastSyncedAt: null,
})

/** The organizations the lab's reader can add and remove, each with the source it gets. */
const LAB_GITHUB_ORGS = [
	{ installationId: LAB_GITHUB_INSTALLATION, login: LAB_GITHUB_ORG, sourceId: githubSource.id },
	{
		installationId: LAB_GITHUB_OTHER_INSTALLATION,
		login: LAB_GITHUB_OTHER_ORG,
		sourceId: "0190f2b3-0000-7000-8000-00000000c062",
	},
]

/** The organization of a lab installation, as the add's answer names it. */
export const labGithubLogin = (installationId: string): string =>
	Arr.findFirst(LAB_GITHUB_ORGS, (org) => org.installationId === installationId).pipe(
		Option.match({ onNone: () => installationId, onSome: (org) => org.login }),
	)

/**
 * What the lab's reader did since the state loaded. `openRouter` and `vercel`: added (true),
 * removed (false) or neither (null). `github`: an installation's id to whether it is a source now.
 */
export type LabSourceChanges = Readonly<{
	openRouter: boolean | null
	github: Readonly<Record<string, boolean>>
	vercel: boolean | null
}>

/**
 * The providers whose cost is in no read any more. GitHub's cost is all `example-org`'s: it leaves
 * when that source is removed, and stays out while a source added again waits for its first sync.
 */
export const labRemovedProviders = (changes: LabSourceChanges): ReadonlyArray<CostProvider> =>
	Arr.filter(
		CostProvider.literals,
		(provider) =>
			(provider === "openrouter" && changes.openRouter === false) ||
			(provider === "github" && Rec.has(changes.github, LAB_GITHUB_INSTALLATION)) ||
			// A team added again is a new source: it has no cost until a sync the lab does not model.
			(provider === "vercel" && changes.vercel !== null),
	)

/**
 * `sources` after what the lab's reader did: a source that was added waits for its first sync, one
 * that was removed is gone.
 */
export const labSourcesWith = (
	sources: CostSourcesResponse,
	changes: LabSourceChanges,
): CostSourcesResponse => {
	const kept = Arr.filter(Schema.encodeSync(CostSourcesResponse)(sources).sources, (entry) =>
		entry.provider === "openrouter"
			? changes.openRouter !== false
			: entry.provider === "vercel"
				? changes.vercel === null
				: entry.provider !== "github" || !Rec.has(changes.github, entry.connectionRef),
	)
	const hasOpenRouter = Arr.some(kept, (entry) => entry.provider === "openrouter")
	return decodeSources({
		sources: [
			...kept,
			...(changes.openRouter === true && !hasOpenRouter ? [justAdded(openRouterSource)] : []),
			...(changes.vercel === true ? [justAdded(vercelSource)] : []),
			...Arr.map(
				Arr.filter(LAB_GITHUB_ORGS, (org) => changes.github[org.installationId] === true),
				(org) =>
					justAdded({
						...githubSource,
						id: org.sourceId,
						connectionRef: org.installationId,
						accountId: org.login,
					}),
			),
		],
	})
}

type InstallationWire = (typeof GithubCostInstallations.Encoded)["installations"][number]

/**
 * The org's GitHub installations as the dialog lists them: the organization that is a source, one
 * that can be added, a user account and a suspended installation. `sources` decides which are added.
 */
export const labGithubInstallations = (sources: CostSourcesResponse): GithubCostInstallations => {
	const added = Arr.filter(sources.sources, (entry) => entry.provider === "github")
	const organization = (installationId: string, accountLogin: string): InstallationWire => ({
		installationId,
		accountLogin,
		state: Arr.some(added, (entry) => entry.connectionRef === installationId) ? "added" : "available",
		settingsUrl: `https://github.com/organizations/${accountLogin}/settings/installations/1000001`,
	})
	return Schema.decodeSync(GithubCostInstallations)({
		installations: [
			organization(LAB_GITHUB_INSTALLATION, LAB_GITHUB_ORG),
			organization(LAB_GITHUB_OTHER_INSTALLATION, LAB_GITHUB_OTHER_ORG),
			{
				installationId: "0190f2b3-0000-4000-8000-00000000e063",
				accountLogin: "example-user",
				state: "user_account",
				settingsUrl: "https://github.com/settings/installations/1000003",
			},
			{
				installationId: "0190f2b3-0000-4000-8000-00000000e064",
				accountLogin: "example-archive",
				state: "inactive",
				settingsUrl:
					"https://github.com/organizations/example-archive/settings/installations/1000004",
			},
		],
	})
}

export const LAB_SOURCES = {
	synced: decodeSources({ sources: [source({}), openRouterSource, githubSource, vercelSource] }),
	none: decodeSources({ sources: [] }),
	pending: decodeSources({
		sources: [
			source({
				status: "pending",
				watermarkDate: null,
				backfillDate: null,
				historyComplete: false,
				lastSyncedAt: null,
				requestsThisMonth: 0,
			}),
		],
	}),
	/** One account backfilling, one whose last sync failed, one paused: every row of the section. */
	mixed: decodeSources({
		sources: [
			source({ status: "syncing", backfillDate: "2026-07-01", historyComplete: false }),
			source({
				id: "0190f2b3-0000-7000-8000-00000000c058",
				accountId: "210987654321",
				status: "error",
				lastError:
					"AccessDeniedException: the role is not authorized to perform ce:GetCostAndUsage. Deploy the connection's stack again.",
				lastErrorReason: "access_denied",
				lastSyncedAt: LAB_NOW_MS - 26 * 3_600_000,
				watermarkDate: dayAt(3),
				requestsThisMonth: 41,
			}),
			source({
				id: "0190f2b3-0000-7000-8000-00000000c059",
				accountId: "345678901234",
				status: "paused",
				watermarkDate: "2026-09-30",
				lastSyncedAt: Date.UTC(2026, 8, 30, 23, 10),
				requestsThisMonth: 0,
			}),
			openRouterSource,
			vercelSource,
		],
	}),
} as const
