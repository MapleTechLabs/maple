export const SEVERITY_COLORS: Record<string, string> = {
	TRACE: "var(--color-severity-trace)",
	DEBUG: "var(--color-severity-debug)",
	INFO: "var(--color-severity-info)",
	WARN: "var(--color-severity-warn)",
	WARNING: "var(--color-severity-warn)",
	ERROR: "var(--color-severity-error)",
	FATAL: "var(--color-severity-fatal)",
	// Code review severities: Critical is also syslog's level; a Note is the review comment's blue.
	CRITICAL: "var(--color-severity-error)",
	NOTE: "var(--color-severity-debug)",
} satisfies Record<string, string>

export const SEVERITY_ORDER = ["FATAL", "ERROR", "WARN", "WARNING", "INFO", "DEBUG", "TRACE"]

export function getSeverityColor(severity: string): string {
	return SEVERITY_COLORS[severity.toUpperCase()] ?? "var(--color-muted-foreground)"
}

// Synonyms share a rank (WARN/WARNING, FATAL/CRITICAL); 0 is the most severe.
const SEVERITY_RANK: Record<string, number> = {
	FATAL: 0,
	CRITICAL: 0,
	ERROR: 1,
	WARN: 2,
	WARNING: 2,
	INFO: 3,
	DEBUG: 4,
	TRACE: 5,
} satisfies Record<string, number>

/** Sort rank for a log level, case-insensitive; unknown levels rank after every known one. */
export function severityRank(severity: string): number {
	return SEVERITY_RANK[severity.toUpperCase()] ?? 99
}
