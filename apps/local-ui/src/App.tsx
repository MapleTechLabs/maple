import { useEffect, useState } from "react"
import { cn } from "@maple/ui/utils"
import { TraceListView } from "./views/trace-list-view"
import { TraceDetailView } from "./views/trace-detail-view"
import { LogsView } from "./views/logs-view"

type Route =
	| { name: "traces" }
	| { name: "trace-detail"; traceId: string }
	| { name: "logs" }

function parseHash(hash: string): Route {
	const path = hash.replace(/^#/, "")
	const traceDetail = path.match(/^\/traces\/(.+)$/)
	if (traceDetail) return { name: "trace-detail", traceId: decodeURIComponent(traceDetail[1]) }
	if (path.startsWith("/logs")) return { name: "logs" }
	return { name: "traces" }
}

function useHashRoute(): Route {
	const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))
	useEffect(() => {
		const onChange = () => setRoute(parseHash(window.location.hash))
		window.addEventListener("hashchange", onChange)
		return () => window.removeEventListener("hashchange", onChange)
	}, [])
	return route
}

function navigate(hash: string) {
	window.location.hash = hash
}

export function App() {
	const route = useHashRoute()
	const activeTab = route.name === "logs" ? "logs" : "traces"

	return (
		<div className="flex h-screen flex-col bg-background text-foreground">
			<header className="flex shrink-0 items-center gap-1 border-b px-4 py-2">
				<span className="mr-4 font-display text-sm font-semibold">Maple — Local</span>
				<NavTab label="Traces" active={activeTab === "traces"} onClick={() => navigate("#/traces")} />
				<NavTab label="Logs" active={activeTab === "logs"} onClick={() => navigate("#/logs")} />
			</header>

			<main className="min-h-0 flex-1">
				{route.name === "trace-detail" ? (
					<TraceDetailView traceId={route.traceId} onBack={() => navigate("#/traces")} />
				) : route.name === "logs" ? (
					<LogsView />
				) : (
					<TraceListView onSelectTrace={(traceId) => navigate(`#/traces/${encodeURIComponent(traceId)}`)} />
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
