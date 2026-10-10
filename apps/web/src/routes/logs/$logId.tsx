import { warmAtoms } from "@effect-router/core"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useAtomValue } from "@/lib/effect-atom"

import { ResultPage } from "@/components/layout/result-page"
import { ResourceNotFound } from "@/components/common/resource-not-found"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { Panel, PanelBody, PanelHeader } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { LogHeroHeader } from "@/components/logs/log-hero-header"
import { LogMetaStrip } from "@/components/logs/log-meta-strip"
import { LogErrorBanner } from "@maple/ui/components/logs/log-error-banner"
import { severityLabel } from "@maple/ui/components/logs/severity-badge"
import { LogAttributesPanel } from "@/components/logs/log-attributes-panel"
import { LogRawPanel } from "@/components/logs/log-raw-panel"
import { LogTraceTimeline } from "@/components/logs/log-trace-timeline"
import { LogContextPanel } from "@/components/logs/log-context-panel"
import { getLogResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { decodeLogKey, encodeLogKey, type LogKey } from "@/lib/log-key"
import type { GetLogInput, GetLogResult, Log } from "@/api/warehouse/logs"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"

// Breadcrumb root shared by every state of this page.
const LOGS_BREADCRUMB = { label: "Logs", href: "/logs" } as const

/** A decoded LogKey carries empty strings for absent context; the query input wants undefined. */
function keyToInput(key: LogKey): GetLogInput {
	return {
		timestamp: key.timestamp,
		serviceName: key.serviceName,
		traceId: key.traceId || undefined,
		spanId: key.spanId || undefined,
	}
}

function bodyExcerpt(body: string): string {
	const trimmed = body.trim()
	return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed || "Log"
}

export const Route = createFileRoute("/logs/$logId")({
	component: LogDetailPage,
	loader: ({ context, params }) => {
		const key = decodeLogKey(params.logId)
		if (key) warmAtoms(context.effectRegistry, [getLogResultAtom({ data: keyToInput(key) })])
	},
})

/** Standalone, shareable detail view for a single log. */
function LogDetailPage() {
	const { logId } = Route.useParams()
	const navigate = useNavigate({ from: Route.fullPath })
	const { effectiveTimezone } = useTimezonePreference()

	const key = decodeLogKey(logId)
	const result = useAtomValue(
		key ? getLogResultAtom({ data: keyToInput(key) }) : disabledResultAtom<GetLogResult>(),
	)

	return (
		<ResultPage
			breadcrumbs={[LOGS_BREADCRUMB]}
			result={result}
			select={(response) => response.data}
			crumb={(log) => bodyExcerpt(log.body)}
			gap="sm"
			errorTitle="Failed to load log"
			invalid={
				key ? undefined : (
					<ResourceNotFound
						{...NOT_FOUND_PROPS}
						title="Log not found"
						description="The link could not be decoded. Check that it was copied in full."
					/>
				)
			}
			loading={
				<>
					<Skeleton className="h-24 w-full rounded-md" />
					<div className="grid gap-3 lg:grid-cols-[1fr_minmax(360px,440px)]">
						<Skeleton className="h-64 w-full rounded-md" />
						<Skeleton className="h-64 w-full rounded-md" />
					</div>
				</>
			}
			notFound={
				<ResourceNotFound
					{...NOT_FOUND_PROPS}
					title="Log not found"
					description={
						<div className="flex flex-col items-center gap-4">
							<p>This log could not be found. It may have aged out of retention.</p>
							<KeyValueList layout="grid" className="text-sm">
								<KeyValue label="Service" mono>
									{key?.serviceName}
								</KeyValue>
								<KeyValue label="Timestamp" mono>
									{key?.timestamp}
								</KeyValue>
							</KeyValueList>
						</div>
					}
				/>
			}
		>
			{(log) => {
				const sev = severityLabel(log.severityText, log.severityNumber).toUpperCase()
				const showErrorBanner = sev === "ERROR" || sev === "FATAL"
				const openLog = (next: Log) =>
					navigate({ to: "/logs/$logId", params: { logId: encodeLogKey(next) } })
				return (
					<>
						{/* Hero + meta as one card, mirroring the drawer's stacked top section. */}
						<Panel tone="background">
							<LogHeroHeader log={log} showClose={false} />
							<LogMetaStrip log={log} timeZone={effectiveTimezone} showOpenFullPage={false} />
							{showErrorBanner && <LogErrorBanner log={log} />}
						</Panel>

						<div className="grid gap-3 lg:grid-cols-[1fr_minmax(360px,440px)]">
							<Panel>
								<PanelHeader title="Attributes" />
								<PanelBody className="p-3">
									<LogAttributesPanel log={log} />
								</PanelBody>
							</Panel>

							<div className="flex flex-col gap-3">
								{log.traceId && (
									<Panel padded="sm">
										<LogTraceTimeline currentLog={log} onLogSelect={openLog} />
									</Panel>
								)}
								<Panel padded="sm">
									<LogContextPanel
										log={log}
										listClassName="max-h-[420px] flex-none"
										onLogSelect={openLog}
									/>
								</Panel>
								<Panel padded="sm">
									<LogRawPanel log={log} />
								</Panel>
							</div>
						</div>
					</>
				)
			}}
		</ResultPage>
	)
}

/** Shared by both not-found states: the way back to the list. */
const NOT_FOUND_PROPS = {
	backLink: <Link to="/logs" />,
	backLabel: "Back to Logs",
}
