// The colour tokens the prototypes read, kept apart from their definitions so the lab page can
// resolve them without loading `@tanstack/charts`.

export const LINE_TOKENS = ["--chart-p99", "--chart-p95", "--chart-p50"] as const
export const AREA_TOKENS = ["--chart-throughput", "--chart-error"] as const
export const CHROME_TOKENS = ["--border", "--background"] as const
