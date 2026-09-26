import type { ReactNode } from "react"
import { AnchoredToastProvider, ToastProvider } from "@maple/ui/components/ui/toast"
import { cn } from "@maple/ui/lib/utils"
import { AttributesProvider } from "@maple/ui/components/attributes"
import {
	CircleWarningIcon,
	CodeIcon,
	DatabaseIcon,
	EyeIcon,
	NetworkNodesIcon,
	PulseIcon,
	SitemapIcon,
} from "@maple/ui/components/icons"
import { TraceListView } from "./views/trace-list-view"
import { TraceDetailView } from "./views/trace-detail-view"
import { LogsView } from "./views/logs-view"
import { MetricsListView } from "./views/metrics-list-view"
import { MetricDetailView } from "./views/metric-detail-view"
import { ErrorsView } from "./views/errors-view"
import { ServicesListView } from "./views/services-list-view"
import { ServiceDetailView } from "./views/service-detail-view"
import { ServiceMapView } from "./views/service-map-view"
import { SessionsListView } from "./views/sessions-list-view"
import { SessionDetailView } from "./views/session-detail-view"
import { canGoBackInApp, decodeSegment, goBack, hrefFor, useLocation } from "./lib/router"
import { AppErrorBoundary } from "./components/app-error-boundary"
import { ConnectButton } from "./components/connect-button"
import { LocalLockup } from "./components/local-lockup"
import { IngestStatus } from "./components/ingest-status"
import { DisconnectedState, RejectedState } from "./components/view-states"
import { useLocalConnection } from "./hooks/use-local-connection"
import { rangeFromQuery } from "./hooks/use-range"
import { highlightJson } from "./lib/highlight"

type Route =
	| { name: "traces" }
	| { name: "trace-detail"; traceId: string }
	| { name: "logs" }
	| { name: "metrics" }
	| { name: "metric-detail"; metricName: string }
	| { name: "services" }
	| { name: "service-detail"; serviceName: string }
	| { name: "service-map" }
	| { name: "errors" }
	| { name: "sessions" }
	| { name: "session-detail"; sessionId: string }

export function parseRoute(path: string): Route {
	const detail = (prefix: string) => {
		const match = path.match(new RegExp(`^/${prefix}/(.+)$`))
		return match ? decodeSegment(match[1]) : null
	}
	const traceId = detail("traces")
	if (traceId !== null) return { name: "trace-detail", traceId }
	const metricName = detail("metrics")
	if (metricName !== null) return { name: "metric-detail", metricName }
	const serviceName = detail("services")
	if (serviceName !== null) return { name: "service-detail", serviceName }
	const sessionId = detail("sessions")
	if (sessionId !== null) return { name: "session-detail", sessionId }
	if (path.startsWith("/errors")) return { name: "errors" }
	if (path.startsWith("/logs")) return { name: "logs" }
	if (path.startsWith("/metrics")) return { name: "metrics" }
	if (path.startsWith("/service-map")) return { name: "service-map" }
	if (path.startsWith("/services")) return { name: "services" }
	if (path.startsWith("/sessions")) return { name: "sessions" }
	return { name: "traces" }
}

type Tab = "traces" | "logs" | "metrics" | "services" | "service-map" | "errors" | "sessions"

function activeTab(route: Route): Tab {
	if (route.name === "errors") return "errors"
	if (route.name === "logs") return "logs"
	if (route.name === "metrics" || route.name === "metric-detail") return "metrics"
	if (route.name === "services" || route.name === "service-detail") return "services"
	if (route.name === "service-map") return "service-map"
	if (route.name === "sessions" || route.name === "session-detail") return "sessions"
	return "traces"
}

const TABS: ReadonlyArray<{ tab: Tab; label: string; icon: ReactNode }> = [
	{ tab: "traces", label: "Traces", icon: <NetworkNodesIcon size={14} /> },
	{ tab: "logs", label: "Logs", icon: <CodeIcon size={14} /> },
	{ tab: "metrics", label: "Metrics", icon: <PulseIcon size={14} /> },
	{ tab: "services", label: "Services", icon: <DatabaseIcon size={14} /> },
	{ tab: "service-map", label: "Service map", icon: <SitemapIcon size={14} /> },
	{ tab: "errors", label: "Errors", icon: <CircleWarningIcon size={14} /> },
	{ tab: "sessions", label: "Sessions", icon: <EyeIcon size={14} /> },
]

/** Detail-page params that must not leak back into a list's filters. */
const DETAIL_ONLY_PARAMS = ["spanId", "view"]

export function App() {
	const { path, query } = useLocation()
	const route = parseRoute(path)
	const tab = activeTab(route)

	// Only a server that is really gone (or refusing this page) swaps the views
	// out; connecting, busy and connected all keep them.
	const connection = useLocalConnection()

	// Tabs carry the cross-cutting context: the service filter and the range.
	const tabQuery = new URLSearchParams({ range: rangeFromQuery(query) })
	const service = query.get("service")
	if (service) tabQuery.set("service", service)

	// Back returns to wherever the detail was opened from (Errors, a session, a
	// log...); with no in-app history it falls back to the list, filters intact.
	const back = (listPath: string) => () => {
		const fallback = new URLSearchParams(query)
		for (const key of DETAIL_ONLY_PARAMS) fallback.delete(key)
		goBack(listPath, fallback)
	}
	const backLabel = (listLabel: string) => (canGoBackInApp() ? "Back" : listLabel)

	return (
		<AttributesProvider highlightJson={highlightJson}>
			<ToastProvider position="bottom-right">
				<AnchoredToastProvider>
					<div className="flex h-dvh flex-col bg-background text-foreground">
						<header className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-2 border-b px-4 py-2">
							<LocalLockup />
							<nav
								aria-label="Sections"
								className="order-last -mx-1 flex w-full min-w-0 items-center gap-1 overflow-x-auto px-1 md:order-none md:mx-0 md:w-auto md:px-0"
							>
								{TABS.map((item) => (
									<NavTab
										key={item.tab}
										label={item.label}
										icon={item.icon}
										href={hrefFor(`/${item.tab}`, tabQuery)}
										active={tab === item.tab}
									/>
								))}
							</nav>
							<div className="ml-auto flex min-w-0 items-center gap-2">
								<IngestStatus />
								<ConnectButton />
							</div>
						</header>

						<main className="min-h-0 flex-1">
							<AppErrorBoundary resetKey={path}>
								{connection.status === "disconnected" ? (
									<DisconnectedState onRetry={connection.retry} />
								) : connection.status === "rejected" && connection.rejection ? (
									<RejectedState
										rejection={connection.rejection}
										onRetry={connection.retry}
									/>
								) : route.name === "trace-detail" ? (
									<TraceDetailView
										traceId={route.traceId}
										backLabel={backLabel("Traces")}
										onBack={back("/traces")}
									/>
								) : route.name === "session-detail" ? (
									<SessionDetailView
										sessionId={route.sessionId}
										backLabel={backLabel("Sessions")}
										onBack={back("/sessions")}
									/>
								) : route.name === "metric-detail" ? (
									<MetricDetailView
										metricName={route.metricName}
										backLabel={backLabel("Metrics")}
										onBack={back("/metrics")}
									/>
								) : route.name === "metrics" ? (
									<MetricsListView />
								) : route.name === "service-detail" ? (
									<ServiceDetailView
										serviceName={route.serviceName}
										backLabel={backLabel("Services")}
										onBack={back("/services")}
									/>
								) : route.name === "services" ? (
									<ServicesListView />
								) : route.name === "service-map" ? (
									<ServiceMapView />
								) : route.name === "errors" ? (
									<ErrorsView />
								) : route.name === "logs" ? (
									<LogsView />
								) : route.name === "sessions" ? (
									<SessionsListView />
								) : (
									<TraceListView />
								)}
							</AppErrorBoundary>
						</main>
					</div>
				</AnchoredToastProvider>
			</ToastProvider>
		</AttributesProvider>
	)
}

function NavTab({
	label,
	icon,
	href,
	active,
}: {
	label: string
	icon: ReactNode
	href: string
	active: boolean
}) {
	return (
		<a
			href={href}
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring",
				active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
			)}
		>
			<span className={active ? "text-foreground" : "text-muted-foreground"}>{icon}</span>
			{label}
		</a>
	)
}
