// The service-flow fixture of `SankeySpike` and its
// error bands, kept apart from the definition so the lab page can build the legend.

export interface SankeyEdge {
	readonly sourceService: string
	readonly targetService: string
	readonly callCount: number
	readonly errorCount: number
}

export interface SankeyNode {
	readonly service: string
}

export const SANKEY_EDGES: ReadonlyArray<SankeyEdge> = [
	{ sourceService: "edge-gateway", targetService: "web", callCount: 48_200, errorCount: 96 },
	{ sourceService: "edge-gateway", targetService: "api", callCount: 31_400, errorCount: 210 },
	{ sourceService: "web", targetService: "api", callCount: 26_800, errorCount: 134 },
	{ sourceService: "web", targetService: "auth", callCount: 12_050, errorCount: 24 },
	{ sourceService: "api", targetService: "auth", callCount: 18_900, errorCount: 57 },
	{ sourceService: "api", targetService: "query-engine", callCount: 22_400, errorCount: 1_120 },
	{ sourceService: "api", targetService: "billing", callCount: 4_300, errorCount: 602 },
	{ sourceService: "api", targetService: "postgres", callCount: 15_600, errorCount: 31 },
	{ sourceService: "auth", targetService: "postgres", callCount: 9_800, errorCount: 12 },
	{ sourceService: "billing", targetService: "postgres", callCount: 3_150, errorCount: 189 },
	{ sourceService: "query-engine", targetService: "clickhouse", callCount: 20_100, errorCount: 402 },
	{ sourceService: "query-engine", targetService: "postgres", callCount: 2_400, errorCount: 8 },
	{ sourceService: "billing", targetService: "clickhouse", callCount: 1_260, errorCount: 302 },
	{ sourceService: "auth", targetService: "clickhouse", callCount: 890, errorCount: 4 },
]

export const SANKEY_NODES: ReadonlyArray<SankeyNode> = [
	{ service: "edge-gateway" },
	{ service: "web" },
	{ service: "api" },
	{ service: "auth" },
	{ service: "query-engine" },
	{ service: "billing" },
	{ service: "postgres" },
	{ service: "clickhouse" },
]

/** `FLOW_BANDS`: the status key, worst first. */
export const FLOW_BANDS = [
	{ key: "error", label: "≥ 5% errors", token: "--destructive" },
	{ key: "warning", label: "1–5% errors", token: "--chart-3" },
	{ key: "healthy", label: "< 1% errors", token: "--chart-1" },
] as const

export const FLOW_TOKENS = [
	"--chart-2",
	"--foreground",
	"--chart-1",
	"--chart-3",
	"--destructive",
	"--background",
]
