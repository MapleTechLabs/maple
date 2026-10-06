// The one severity vocabulary for status colour. Domain maps (alert severity,
// anomaly kind, health, log level) key into `Tone` instead of each carrying
// its own Tailwind classes, so "warning" is the same amber everywhere.

export type Tone = "crit" | "warn" | "ok" | "info" | "neutral"

/** Value text: table cells, stat values, inline numbers. */
export const TONE_TEXT: Record<Tone, string> = {
	crit: "text-severity-error",
	warn: "text-severity-warn",
	ok: "text-foreground",
	info: "text-severity-info",
	neutral: "text-muted-foreground",
} satisfies Record<Tone, string>

/** Solid fill: dots, meter bars, legend swatches. */
export const TONE_FILL: Record<Tone, string> = {
	crit: "bg-severity-error",
	warn: "bg-severity-warn",
	ok: "bg-severity-info",
	info: "bg-severity-info",
	neutral: "bg-muted-foreground/50",
} satisfies Record<Tone, string>

/** Tinted surface + text: chips, badges, row highlights. */
export const TONE_SOFT: Record<Tone, string> = {
	crit: "bg-severity-error/12 text-severity-error",
	warn: "bg-severity-warn/12 text-severity-warn",
	ok: "bg-severity-info/12 text-severity-info",
	info: "bg-severity-info/12 text-severity-info",
	neutral: "bg-muted text-muted-foreground",
} satisfies Record<Tone, string>

/** Border accent for outlined chips and callouts. */
export const TONE_BORDER: Record<Tone, string> = {
	crit: "border-severity-error/40",
	warn: "border-severity-warn/40",
	ok: "border-severity-info/40",
	info: "border-severity-info/40",
	neutral: "border-border",
} satisfies Record<Tone, string>

/** Raw CSS colour for SVG fills and inline styles. */
export const TONE_COLOR: Record<Tone, string> = {
	crit: "var(--color-severity-error)",
	warn: "var(--color-severity-warn)",
	ok: "var(--color-severity-info)",
	info: "var(--color-severity-info)",
	neutral: "var(--color-muted-foreground)",
} satisfies Record<Tone, string>

/** Maps any severity-ish word (log levels, alert severities, statuses) onto a tone. */
export function severityTone(level: string | null | undefined): Tone {
	switch ((level ?? "").toLowerCase()) {
		case "fatal":
		case "critical":
		case "crit":
		case "error":
		case "err":
		case "unhealthy":
		case "failed":
			return "crit"
		case "warn":
		case "warning":
		case "degraded":
			return "warn"
		case "ok":
		case "healthy":
		case "success":
			return "ok"
		case "info":
		case "notice":
			return "info"
		default:
			return "neutral"
	}
}
