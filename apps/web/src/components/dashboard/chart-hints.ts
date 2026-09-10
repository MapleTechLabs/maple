/**
 * Explanatory copy for metric cards whose name says nothing about what the
 * number is. Kept out of the route files so the service and release overviews
 * describe the same chart the same way, and so the docs link lives in one place.
 */
export const APDEX_HINT = {
	text: "The share of requests that were fast enough to keep a user happy, scored from 0 to 1 against a 500ms target. Slow and failed requests pull it down.",
	href: "https://maple.dev/docs/alerting/apdex-alerts",
} as const
