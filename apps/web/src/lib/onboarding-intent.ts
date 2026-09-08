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

type IntentCopy = {
	label: string
	/** One line under the label. What the surface shows, not what it promises. */
	title: string
	/** Lower-case noun for the combined setup sentence. */
	focus: string
	setupHint: string
}

export const ONBOARDING_INTENTS = {
	traces: {
		label: "Traces",
		title: "One request, span by span, across every service.",
		focus: "traces",
		setupHint: "Connect a service to see its first trace.",
	},
	logs: {
		label: "Logs",
		title: "Structured search. Every line links to its trace.",
		focus: "logs",
		setupHint: "Ship logs over OTLP and they land next to their traces.",
	},
	metrics: {
		label: "Metrics",
		title: "Time series per service, on your own dashboards.",
		focus: "metrics",
		setupHint: "Send metrics over OTLP to chart them per service.",
	},
	errors: {
		label: "Errors",
		title: "Exceptions grouped into issues, trace attached.",
		focus: "errors",
		setupHint: "Connect your app to see exceptions grouped into issues.",
	},
	replays: {
		label: "Replays",
		title: "Browser sessions, with the network trace behind them.",
		focus: "session replays",
		setupHint: "Add the browser SDK to record sessions alongside their traces.",
	},
	service_map: {
		label: "Service Map",
		title: "Which services call which, with latency on every edge.",
		focus: "the service map",
		setupHint: "Connect two services and the map draws the edge between them.",
	},
	infrastructure: {
		label: "Infrastructure",
		title: "Hosts, containers, Kubernetes, Cloudflare.",
		focus: "infrastructure",
		setupHint: "Point the collector or the Docker agent at Maple to see hosts and containers.",
	},
	alerts: {
		label: "Alerts",
		title: "A threshold crossed opens an incident.",
		focus: "alerts",
		setupHint: "Connect a service, then put a threshold on its first signal.",
	},
} satisfies Record<OnboardingIntent, IntentCopy>

export function getOnboardingSetupHint(intents: readonly OnboardingIntent[]): string {
	if (intents.length === 0) return "Drop in the snippet and we'll auto-detect your first traces."
	if (intents.length === 1) return ONBOARDING_INTENTS[intents[0]].setupHint
	const focuses = intents.map((intent) => ONBOARDING_INTENTS[intent].focus)
	return `Connect your app to explore ${new Intl.ListFormat("en", { type: "conjunction" }).format(focuses)}.`
}
