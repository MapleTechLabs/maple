import { useNavigate } from "@tanstack/react-router"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Badge } from "@maple/ui/components/ui/badge"

export interface SessionRow {
	readonly sessionId: string
	readonly startTime: string
	readonly durationMs: number | null
	readonly status: string
	readonly userId: string
	readonly urlInitial: string
	readonly browserName: string
	readonly osName: string
	readonly deviceType: string
	readonly country: string
	readonly serviceName: string
	readonly pageViews: number
	readonly clickCount: number
	readonly errorCount: number
	readonly traceCount: number
}

function formatDuration(ms: number | null): string {
	if (ms == null || ms <= 0) return "—"
	const totalSeconds = Math.round(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function formatRelative(startTime: string): string {
	const parsed = Date.parse(startTime.includes("T") ? startTime : `${startTime.replace(" ", "T")}Z`)
	if (Number.isNaN(parsed)) return startTime
	return new Date(parsed).toLocaleString()
}

function hostFromUrl(url: string): string {
	try {
		return new URL(url).host
	} catch {
		return url
	}
}

export function SessionsTable({ sessions }: { sessions: ReadonlyArray<SessionRow> }) {
	const navigate = useNavigate()

	if (sessions.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center rounded-md border border-dashed p-12 text-center">
				<p className="text-sm font-medium">No sessions recorded</p>
				<p className="mt-1 text-sm text-muted-foreground">
					Install <code className="font-mono">@maple/browser</code> and call{" "}
					<code className="font-mono">MapleBrowser.init(...)</code> to start capturing replays.
				</p>
			</div>
		)
	}

	return (
		<div className="rounded-md border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Started</TableHead>
						<TableHead>Duration</TableHead>
						<TableHead>User</TableHead>
						<TableHead>Page</TableHead>
						<TableHead>Browser</TableHead>
						<TableHead>Device</TableHead>
						<TableHead className="text-right">Clicks</TableHead>
						<TableHead className="text-right">Errors</TableHead>
						<TableHead className="text-right">Traces</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{sessions.map((session) => (
						<TableRow
							key={session.sessionId}
							className="cursor-pointer"
							onClick={() =>
								navigate({
									to: "/replays/$sessionId",
									params: { sessionId: session.sessionId },
									search: { t: session.startTime },
								})
							}
						>
							<TableCell className="whitespace-nowrap">{formatRelative(session.startTime)}</TableCell>
							<TableCell>{formatDuration(session.durationMs)}</TableCell>
							<TableCell className="max-w-40 truncate">{session.userId || "Anonymous"}</TableCell>
							<TableCell className="max-w-48 truncate text-muted-foreground">
								{hostFromUrl(session.urlInitial)}
							</TableCell>
							<TableCell>{session.browserName}</TableCell>
							<TableCell className="capitalize">{session.deviceType}</TableCell>
							<TableCell className="text-right tabular-nums">{session.clickCount}</TableCell>
							<TableCell className="text-right">
								{session.errorCount > 0 ? (
									<Badge variant="destructive">{session.errorCount}</Badge>
								) : (
									<span className="tabular-nums text-muted-foreground">0</span>
								)}
							</TableCell>
							<TableCell className="text-right tabular-nums">{session.traceCount}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	)
}
