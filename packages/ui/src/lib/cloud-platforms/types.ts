import type { IconComponent } from "../../components/icons"

// Platform-agnostic model for serverless / cloud span annotations.
//
// Providers like Cloudflare Workers, Vercel Functions, and AWS Lambda each
// annotate spans with their own attribute namespace. Rather than branch on a
// specific provider throughout the trace UI, every provider is described by a
// `CloudPlatformAdapter` that normalizes its attributes into a single
// `CloudPlatformInfo`. The trace views consume only that normalized shape, so
// adding a provider never touches a component.

/** Provider-native outcome, distinct from the OTEL span status. */
export interface CloudPlatformOutcome {
	/** Raw outcome label, e.g. "ok", "exceededCpu", "exception". */
	value: string
	/** Whether this outcome should read as a failure. */
	bad: boolean
}

/** One key/value row in the detail-panel summary. */
export interface CloudPlatformField {
	label: string
	/** Full value — what gets copied. */
	value: string
	/** Shortened value to render; defaults to `value`. */
	display?: string
	/** Render with a copy affordance. */
	copyable?: boolean
	/** Span both grid columns (for long values like ids). */
	wide?: boolean
}

/** Normalized view of a span's provider-specific annotations. */
export interface CloudPlatformInfo {
	/** Stable id, e.g. "cloudflare" | "vercel" | "aws_lambda". */
	id: string
	/** Full display name, e.g. "Cloudflare Worker". */
	label: string
	/** Short kind chip, e.g. "Worker" | "Function". */
	kind: string
	/** Brand icon. */
	Icon: IconComponent
	/** Tailwind class tinting the icon to the brand color. */
	accentClassName: string
	/** Compact edge/region label, e.g. "ORD · ENAM" or "iad1". */
	edge: string | null
	/** Human geo location for tooltips, e.g. "Council Bluffs, US". */
	location: string | null
	/** Provider-native outcome. */
	outcome: CloudPlatformOutcome | null
	/** Ordered rows for the detail-panel summary. */
	fields: ReadonlyArray<CloudPlatformField>
}

export interface CloudPlatformAdapter {
	/** Stable id, must match the `id` of the info it returns. */
	id: string
	/** Returns normalized info when `attrs` belong to this platform, else null. */
	detect(attrs: Record<string, string>): CloudPlatformInfo | null
}

/** Badge styling for a platform outcome — shared across providers. */
export function outcomeBadgeStyle(bad: boolean): string {
	return bad
		? "bg-severity-error/15 text-severity-error border-severity-error/30"
		: "bg-severity-info/15 text-severity-info border-severity-info/30"
}

/** First present, non-blank value among `keys`. */
export function pickAttr(attrs: Record<string, string>, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = attrs[key]
		if (value != null && value.trim() !== "") return value
	}
	return null
}

/** Join present, non-blank parts with a middot — ["ORD","ENAM"] → "ORD · ENAM". */
export function joinEdge(...parts: Array<string | null | undefined>): string | null {
	return parts.filter((p): p is string => !!p && p.trim() !== "").join(" · ") || null
}
