/**
 * Dedup keys for the paging providers (PagerDuty, incident.io), which both open one alert per key
 * and close it with a resolve under the same key.
 */
import type { AlertSeverity } from "@maple/domain/http"
import type { DispatchContext } from "./context"

/**
 * A rule with both a warning and a critical tier pages critical under its own
 * dedup key: re-triggering the warning alert's key would only update that alert,
 * and an acknowledged alert does not page again, so an escalation could go
 * unheard. Every other rule keeps the incident's single key, which is what its
 * already-open alerts were raised under.
 */
const criticalHasOwnKey = (context: Pick<DispatchContext, "ruleSeverities">): boolean =>
	context.ruleSeverities !== undefined &&
	context.ruleSeverities.includes("warning") &&
	context.ruleSeverities.includes("critical")

export const criticalDedupKey = (dedupeKey: string): string => `${dedupeKey}:critical`

/**
 * The tier a delivery's key is chosen from: the queued event's, unless the
 * incident has since fallen below it. A critical trigger retried after a
 * de-escalation must not re-open (and re-page) the alert it closed.
 */
export const keySeverity = (context: Pick<DispatchContext, "severity" | "incidentSeverity">): AlertSeverity =>
	context.severity === "critical" && context.incidentSeverity === "warning" ? "warning" : context.severity

export const pagingDedupKey = (
	context: Pick<DispatchContext, "dedupeKey" | "ruleSeverities">,
	severity: AlertSeverity,
): string =>
	severity === "critical" && criticalHasOwnKey(context)
		? criticalDedupKey(context.dedupeKey)
		: context.dedupeKey

/** The key the primary request goes out under: a resolve closes the warning-keyed alert. */
export const primaryDedupKey = (context: DispatchContext): string =>
	pagingDedupKey(context, context.eventType === "resolve" ? "warning" : keySeverity(context))

/**
 * Whether this delivery must also resolve the critical-keyed alert: the incident resolved or fell
 * back to warning. The rule may have dropped its critical tier since the key was minted, so an
 * incident that peaked at critical closes it too. Resolving a key the provider never saw is a no-op.
 */
export const closesCriticalKey = (context: DispatchContext): boolean => {
	const mayHoldCriticalKey = criticalHasOwnKey(context) || context.incidentPeakSeverity === "critical"
	// Judged by where the incident is now, not by the queued event: a warning
	// reminder delivered after an escalation must leave the critical page open.
	const closesCritical =
		context.eventType === "resolve" ||
		(context.eventType !== "test" && (context.incidentSeverity ?? context.severity) === "warning")
	return mayHoldCriticalKey && closesCritical
}
