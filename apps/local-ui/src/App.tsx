import { cn } from "@maple/ui/utils"
import { TraceListView } from "./views/trace-list-view"
import { TraceDetailView } from "./views/trace-detail-view"
import { LogsView } from "./views/logs-view"
import { SessionsListView } from "./views/sessions-list-view"
import { SessionDetailView } from "./views/session-detail-view"
import { navigate, useLocation } from "./lib/router"
import { ConnectButton } from "./components/connect-button"

type Route =
	| { name: "traces" }
	| { name: "trace-detail"; traceId: string }
	| { name: "logs" }
	| { name: "sessions" }
	| { name: "session-detail"; sessionId: string }

function parseRoute(path: string): Route {
	const traceDetail = path.match(/^\/traces\/(.+)$/)
	if (traceDetail) return { name: "trace-detail", traceId: decodeURIComponent(traceDetail[1]) }
	const sessionDetail = path.match(/^\/sessions\/(.+)$/)
	if (sessionDetail) return { name: "session-detail", sessionId: decodeURIComponent(sessionDetail[1]) }
	if (path.startsWith("/logs")) return { name: "logs" }
	if (path.startsWith("/sessions")) return { name: "sessions" }
	return { name: "traces" }
}

type Tab = "traces" | "logs" | "sessions"

function activeTab(route: Route): Tab {
	if (route.name === "logs") return "logs"
	if (route.name === "sessions" || route.name === "session-detail") return "sessions"
	return "traces"
}

export function App() {
	const { path, query } = useLocation()
	const route = parseRoute(path)
	const tab = activeTab(route)

	// Carry the current filter context (full query) onto detail pages and back,
	// so opening an item and returning preserves the list's filters.
	const carry = () => new URLSearchParams(query)

	// Switching top-level tabs keeps the cross-cutting filters (service + range).
	const switchTab = (target: string) => {
		const shared = new URLSearchParams()
		const service = query.get("service")
		const range = query.get("range")
		if (service) shared.set("service", service)
		if (range) shared.set("range", range)
		navigate(target, shared)
	}

	return (
		<div className="flex h-screen flex-col bg-background text-foreground">
			<header className="flex shrink-0 items-center gap-1 border-b px-4 py-2">
				<span className="mr-4 font-display text-sm font-semibold">Maple — Local</span>
				<NavTab label="Traces" active={tab === "traces"} onClick={() => switchTab("/traces")} />
				<NavTab label="Logs" active={tab === "logs"} onClick={() => switchTab("/logs")} />
				<NavTab label="Sessions" active={tab === "sessions"} onClick={() => switchTab("/sessions")} />
				<div className="ml-auto">
					<ConnectButton />
				</div>
			</header>

			<main className="min-h-0 flex-1">
				{route.name === "trace-detail" ? (
					<TraceDetailView traceId={route.traceId} onBack={() => navigate("/traces", carry())} />
				) : route.name === "session-detail" ? (
					<SessionDetailView
						sessionId={route.sessionId}
						onBack={() => navigate("/sessions", carry())}
						onSelectTrace={(traceId) => navigate(`/traces/${encodeURIComponent(traceId)}`)}
					/>
				) : route.name === "logs" ? (
					<LogsView />
				) : route.name === "sessions" ? (
					<SessionsListView
						onSelectSession={(sessionId) =>
							navigate(`/sessions/${encodeURIComponent(sessionId)}`, carry())
						}
					/>
				) : (
					<TraceListView
						onSelectTrace={(traceId) => navigate(`/traces/${encodeURIComponent(traceId)}`, carry())}
					/>
				)}
			</main>
		</div>
	)
}

function NavTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rounded-md px-3 py-1 text-sm transition-colors",
				active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
			)}
		>
			{label}
		</button>
	)
}
