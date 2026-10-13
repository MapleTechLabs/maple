import { useMemo, useState } from "react"
import { PageLayout } from "@maple/ui/components/ui/page-layout"
import type { SessionTag } from "@maple/domain/query-engine"

import { ReplaysToolbar } from "@/components/replays/replays-toolbar"
import { SessionsList, type SessionRow } from "@/components/replays/sessions-list"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"

/**
 * `/replays` without a warehouse behind it.
 *
 * The rows follow a real day of the dogfood org: most sessions are bots, bounces
 * and idle tabs, interleaved with the few engaged ones, plus an errored bot and a
 * live bounce, which must never fold into a low-signal run.
 */

const WIDTHS = [
	{ label: "Full", value: null },
	{ label: "1000px", value: 1000 },
	{ label: "700px", value: 700 },
	{ label: "380px", value: 380 },
] as const

const BASE: SessionRow = {
	sessionId: "",
	startTime: "",
	durationMs: 0,
	status: "ended",
	lastActivityAt: null,
	userId: null,
	userName: "",
	userEmail: "",
	groupId: "",
	groupName: "",
	urlInitial: "https://maple.dev/",
	browserName: "Chrome",
	osName: "macOS",
	deviceType: "desktop",
	country: "US",
	serviceName: "landing",
	pageViews: 1,
	clickCount: 0,
	errorCount: 0,
	traceCount: 0,
	recorded: "true",
	tags: ["engaged"],
}

type Fixture = Partial<SessionRow> & { readonly minutesAgo: number; readonly tags: ReadonlyArray<SessionTag> }

const FIXTURES: ReadonlyArray<Fixture> = [
	{ minutesAgo: 1, tags: ["bounce", "new_visitor"], status: "active", durationMs: null },
	{ minutesAgo: 5, tags: ["bounce"], country: "DE" },
	{
		minutesAgo: 16,
		tags: ["bounce", "signed_in"],
		userId: "user_39gP858vUksrA7uoGJ3Y9fa8sZM",
		groupName: "Superwall",
		urlInitial: "https://maple.dev/customers/superwall/",
		durationMs: 1_000,
		traceCount: 1,
	},
	{
		minutesAgo: 16,
		tags: ["bot"],
		urlInitial: "https://maple.dev/observability/",
		recorded: "false",
		country: "CN",
	},
	{
		minutesAgo: 19,
		tags: ["engaged", "signed_in"],
		userId: "user_2",
		userName: "David Granzin",
		userEmail: "david@maple.dev",
		groupName: "Maple",
		urlInitial: "https://app.maple.dev/replays",
		durationMs: 1_132_000,
		pageViews: 4,
		clickCount: 3,
		traceCount: 32,
		country: "DE",
	},
	{
		minutesAgo: 29,
		tags: ["bot"],
		urlInitial: "https://maple.dev/docs/integrations/github/",
		recorded: "false",
	},
	{ minutesAgo: 40, tags: ["bounce"] },
	{
		minutesAgo: 58,
		tags: ["bot"],
		urlInitial: "https://maple.dev/opentelemetry/",
		durationMs: 8_000,
		traceCount: 2,
	},
	{
		minutesAgo: 61,
		tags: ["bounce"],
		urlInitial: "https://maple.dev/compare/better-stack/",
		durationMs: 3_000,
	},
	{
		minutesAgo: 62,
		tags: ["bot"],
		urlInitial: "https://maple.dev/features/distributed-tracing/",
		recorded: "false",
	},
	{
		minutesAgo: 64,
		tags: ["engaged", "new_visitor"],
		urlInitial: "https://maple.dev/pricing/",
		userId: "user_4",
		userName: "Priya Raman",
		userEmail: "priya@superwall.com",
		groupName: "Superwall",
		durationMs: 338_000,
		pageViews: 6,
		clickCount: 14,
		traceCount: 4,
		country: "GB",
		browserName: "Safari",
	},
	{
		minutesAgo: 70,
		tags: ["idle"],
		urlInitial: "https://maple.dev/customers/superwall/",
		durationMs: 338_000,
	},
	{
		minutesAgo: 75,
		tags: ["bot"],
		urlInitial: "https://maple.dev/docs/",
		errorCount: 3,
		traceCount: 1,
		country: "SG",
	},
	{
		minutesAgo: 81,
		tags: ["bounce"],
		urlInitial: "https://maple.dev/features/ai-mcp-integration/",
		durationMs: 18_000,
	},
	{
		minutesAgo: 88,
		tags: ["glance"],
		urlInitial: "https://maple.dev/compare/datadog/",
		durationMs: 10_000,
		clickCount: 1,
	},
	{
		minutesAgo: 96,
		tags: ["engaged", "signed_in"],
		userId: "user_3",
		userName: "Ada Lovelace",
		userEmail: "ada@acme.com",
		groupName: "Acme Inc",
		urlInitial: "https://app.maple.dev/traces",
		durationMs: 2_950_000,
		pageViews: 22,
		clickCount: 131,
		errorCount: 2,
		traceCount: 88,
		deviceType: "desktop",
		browserName: "Firefox",
		country: "FR",
	},
	{ minutesAgo: 110, tags: ["bot"], urlInitial: "https://maple.dev/blog/", country: "US" },
	{
		minutesAgo: 118,
		tags: ["idle"],
		urlInitial: "https://maple.dev/",
		durationMs: 1_200_000,
		deviceType: "mobile",
	},
	{ minutesAgo: 121, tags: ["bounce"], deviceType: "mobile", browserName: "Safari" },
	{
		minutesAgo: 140,
		tags: ["engaged", "signed_in"],
		urlInitial: "https://app.maple.dev/services",
		userId: "user_5",
		userEmail: "ops@northwind.io",
		groupName: "Northwind Logistics International",
		durationMs: 94_000,
		pageViews: 3,
		clickCount: 8,
		country: "IN",
	},
]

function buildRows(nowMs: number): ReadonlyArray<SessionRow> {
	const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "")
	return FIXTURES.map(({ minutesAgo, ...fixture }, index) => {
		const start = nowMs - minutesAgo * 60_000
		return {
			...BASE,
			...fixture,
			sessionId: `${(0x3d7f797c + index * 0x1f3a1).toString(16)}-lab`,
			startTime: iso(start),
			lastActivityAt: iso(start + (fixture.durationMs ?? 0)),
		}
	})
}

export function ReplaysListLab() {
	const [nowMs] = useState(() => Date.now())
	const rows = useMemo(() => buildRows(nowMs), [nowMs])
	const [width, setWidth] = useState<number | null>(null)
	const [errorsOnly, setErrorsOnly] = useState(false)
	const [engagedOnly, setEngagedOnly] = useState(false)
	const [tag, setTag] = useState<SessionTag | undefined>()
	const [group, setGroup] = useState<string | undefined>()
	const visible = rows.filter(
		(row) =>
			(!errorsOnly || row.errorCount > 0) &&
			(!engagedOnly || row.tags.includes("engaged")) &&
			(tag === undefined || row.tags.includes(tag)) &&
			(group === undefined || row.groupName === group),
	)

	return (
		<div className="flex h-svh flex-col gap-4 p-6">
			<div className="flex items-center gap-2">
				{(tag !== undefined || group !== undefined) && (
					<button
						type="button"
						onClick={() => {
							setTag(undefined)
							setGroup(undefined)
						}}
						className="rounded border border-border px-2 py-1 text-xs"
					>
						Clear {[tag, group].filter(Boolean).join(" + ")}
					</button>
				)}
				{WIDTHS.map((option) => (
					<button
						key={option.label}
						type="button"
						onClick={() => setWidth(option.value)}
						className={
							width === option.value
								? "rounded border border-border bg-accent px-2 py-1 text-xs"
								: "rounded border border-border px-2 py-1 text-xs text-muted-foreground"
						}
					>
						{option.label}
					</button>
				))}
			</div>
			<div className="flex min-h-0 flex-1 flex-col" style={width === null ? undefined : { width }}>
				<PageRefreshProvider>
					<PageLayout.Root>
						<PageLayout.Content>
							<PageLayout.StickyArea className="pb-3">
								<ReplaysToolbar
									query=""
									onSearch={() => {}}
									errorSessions={rows.filter((row) => row.errorCount > 0).length}
									errorsOnly={errorsOnly}
									onToggleErrorsOnly={() => setErrorsOnly((on) => !on)}
									engagedSessions={
										rows.filter((row) => row.tags.includes("engaged")).length
									}
									engagedOnly={engagedOnly}
									onToggleEngagedOnly={() => setEngagedOnly((on) => !on)}
								/>
							</PageLayout.StickyArea>
							<PageLayout.ScrollArea className="pt-0">
								<SessionsList
									sessions={visible}
									durationP95={1_200_000}
									nowMs={nowMs}
									collapseLowSignal={!engagedOnly && tag === undefined}
									onFilterTag={setTag}
									onFilterGroup={setGroup}
								/>
							</PageLayout.ScrollArea>
						</PageLayout.Content>
					</PageLayout.Root>
				</PageRefreshProvider>
			</div>
		</div>
	)
}
