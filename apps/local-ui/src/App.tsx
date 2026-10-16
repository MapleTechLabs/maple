import { AnchoredToastProvider, ToastProvider } from "@maple/ui/components/ui/toast"
import { AttributesProvider } from "@maple/ui/components/attributes"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@maple/ui/components/ui/sidebar"
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
import { QueryView } from "./views/query-view"
import { canGoBackInApp, decodeSegment, goBack, useLocation } from "./lib/router"
import { AppErrorBoundary } from "./components/app-error-boundary"
import { AppSidebar, type Section } from "./components/app-sidebar"
import { LocalLockup } from "./components/local-lockup"
import { DisconnectedState, RejectedState } from "./components/view-states"
import { StaleDataNotice } from "./components/stale-data-notice"
import { useLocalConnection } from "./hooks/use-local-connection"
import { useShownData } from "./hooks/use-shown-data"
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
	| { name: "query" }

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
	if (path.startsWith("/query")) return { name: "query" }
	return { name: "traces" }
}

function activeSection(route: Route): Section {
	if (route.name === "errors") return "errors"
	if (route.name === "logs") return "logs"
	if (route.name === "metrics" || route.name === "metric-detail") return "metrics"
	if (route.name === "services" || route.name === "service-detail") return "services"
	if (route.name === "service-map") return "service-map"
	if (route.name === "sessions" || route.name === "session-detail") return "sessions"
	if (route.name === "query") return "query"
	return "traces"
}

/** Detail-page params that must not leak back into a list's filters. */
const DETAIL_ONLY_PARAMS = ["spanId", "view"]

export function App() {
	const { path, query } = useLocation()
	const route = parseRoute(path)
	const section = activeSection(route)

	// Only a server that is really gone (or refusing this page) swaps the views
	// out; connecting, busy and connected all keep them. A gone server with saved
	// results keeps them too, and the notice says what they are.
	const connection = useLocalConnection()
	const { hasCache } = useShownData()
	const disconnected = connection.status === "disconnected"

	// Section links carry the cross-cutting context: the service filter and the range.
	const sectionQuery = new URLSearchParams({ range: rangeFromQuery(query) })
	const service = query.get("service")
	if (service) sectionQuery.set("service", service)

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
					<SidebarProvider defaultOpen={readSidebarOpen()} className="min-h-dvh">
						<AppSidebar active={section} linkQuery={sectionQuery} />
						<SidebarInset className="h-dvh text-foreground">
							<header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 md:hidden">
								<SidebarTrigger className="-ml-1" />
								<LocalLockup />
							</header>
							<div className="relative min-h-0 flex-1">
								<AppErrorBoundary resetKey={path}>
									{disconnected && !hasCache ? (
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
									) : route.name === "query" ? (
										<QueryView />
									) : (
										<TraceListView />
									)}
								</AppErrorBoundary>
								{connection.status === "rejected" || (disconnected && !hasCache) ? null : (
									<StaleDataNotice disconnected={disconnected} onRetry={connection.retry} />
								)}
							</div>
						</SidebarInset>
					</SidebarProvider>
				</AnchoredToastProvider>
			</ToastProvider>
		</AttributesProvider>
	)
}

/** The shared provider persists the collapsed state in this cookie but leaves reading it to the app. */
function readSidebarOpen(): boolean {
	return !document.cookie.split("; ").includes("sidebar_state=false")
}
