/**
 * The intent step asks which of Maple's surfaces the user came for. Each entry
 * is one thing the sidebar actually has — named the way the sidebar names it —
 * so the choice maps straight onto a page and a setup hint, not a theme.
 */
export const ONBOARDING_INTENT_IDS = [
	"traces",
	"logs",
	"metrics",
	"errors",
	"replays",
	"service_map",
	"infrastructure",
	"alerts",
] as const

export type OnboardingIntent = (typeof ONBOARDING_INTENT_IDS)[number]

/** Card copy. Only the quick-start route reads this, so it stays out of the startup bundle. */
export const ONBOARDING_INTENTS = {
	traces: { label: "Traces", title: "One request, span by span, across every service." },
	logs: { label: "Logs", title: "Structured search. Every line links to its trace." },
	metrics: { label: "Metrics", title: "Time series per service, on your own dashboards." },
	errors: { label: "Errors", title: "Exceptions grouped into issues, trace attached." },
	replays: { label: "Replays", title: "Browser sessions, with the network trace behind them." },
	service_map: { label: "Service Map", title: "Which services call which, with latency on every edge." },
	infrastructure: { label: "Infrastructure", title: "Hosts, containers, Kubernetes, Cloudflare." },
	alerts: { label: "Alerts", title: "A threshold crossed opens an incident." },
} satisfies Record<OnboardingIntent, { label: string; title: string }>

/**
 * What the dashboard's setup checklist says once the wizard is done. `focus` is
 * the lower-case noun for the combined sentence. Kept apart from the card copy
 * above: this module is on every dashboard page's startup path.
 */
const SETUP_HINTS = {
	traces: { focus: "traces", hint: "Connect a service to see its first trace." },
	logs: { focus: "logs", hint: "Ship logs over OTLP and they land next to their traces." },
	metrics: { focus: "metrics", hint: "Send metrics over OTLP to chart them per service." },
	errors: { focus: "errors", hint: "Connect your app to see exceptions grouped into issues." },
	replays: {
		focus: "session replays",
		hint: "Add the browser SDK to record sessions alongside their traces.",
	},
	service_map: {
		focus: "the service map",
		hint: "Connect two services and the map draws the edge between them.",
	},
	infrastructure: {
		focus: "infrastructure",
		hint: "Point the collector or the Docker agent at Maple to see hosts and containers.",
	},
	alerts: { focus: "alerts", hint: "Connect a service, then put a threshold on its first signal." },
} satisfies Record<OnboardingIntent, { focus: string; hint: string }>

export function getOnboardingSetupHint(intents: readonly OnboardingIntent[]): string {
	if (intents.length === 0) return "Drop in the snippet and we'll auto-detect your first traces."
	if (intents.length === 1) return SETUP_HINTS[intents[0]].hint
	const focuses = intents.map((intent) => SETUP_HINTS[intent].focus)
	return `Connect your app to explore ${new Intl.ListFormat("en", { type: "conjunction" }).format(focuses)}.`
}
