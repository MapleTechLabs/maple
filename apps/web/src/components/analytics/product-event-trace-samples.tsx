import { Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { productEventTraceSamplesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { ChartBarTrendUpIcon } from "@/components/icons"
import { TruncatedId } from "@maple/ui/components/ui/truncated-id"
import { ListRow } from "@maple/ui/components/ui/list-row"
import { Panel, PanelHeader } from "@maple/ui/components/ui/panel"
import { ErrorState } from "@/components/common/error-state"

/**
 * Recent traces behind one product event. Renders nothing when empty (browser
 * and `/v1/events` rows carry no trace, so "none" is not a finding), but a
 * failure is shown: the user filtered to this event and asked.
 */
export function ProductEventTraceSamples({
	eventName,
	startTime,
	endTime,
}: {
	eventName: string
	startTime: string
	endTime: string
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const result = useAtomValue(
		productEventTraceSamplesResultAtom({ data: { eventName, startTime, endTime, limit: 10 } }),
	)

	return Result.builder(result)
		.onSuccess((response) => {
			if (response.data.length === 0) return null
			return (
				<Panel>
					<PanelHeader className="justify-start gap-2 px-3 py-2">
						<ChartBarTrendUpIcon className="size-3.5 text-muted-foreground" />
						<h2 className="text-xs font-medium">Traces behind “{eventName}”</h2>
					</PanelHeader>
					<ul className="divide-y">
						{/* Index included: at-least-once ingest can duplicate a row, and
						    one trace can fire the event from several spans. */}
						{response.data.map((sample, index) => (
							<li key={`${index}:${sample.traceId}:${sample.spanId}`}>
								<ListRow
									density="compact"
									className="gap-2 py-2"
									// `spanId` selects the annotated span in the waterfall and `t` narrows the
									// partition scan to a ±1h window; without it the hierarchy query reads every retained daily partition.
									render={
										<Link
											to="/traces/$traceId"
											params={{ traceId: sample.traceId }}
											search={{ spanId: sample.spanId, t: sample.timestamp }}
										/>
									}
									leading={<TruncatedId value={sample.traceId} kind="trace" />}
									title={
										<span className="font-normal">
											{sample.serviceName}
											{sample.userId || sample.visitorId ? (
												<span className="text-muted-foreground">
													{sample.serviceName === "" ? "" : " "}·{" "}
													{sample.userId || sample.visitorId}
												</span>
											) : null}
										</span>
									}
									trailing={
										<span className="text-muted-foreground">
											{formatTimestampInTimezone(sample.timestamp, {
												timeZone: effectiveTimezone,
											})}
										</span>
									}
								/>
							</li>
						))}
					</ul>
				</Panel>
			)
		})
		.onError((error) => (
			<Panel>
				<PanelHeader className="justify-start gap-2 px-3 py-2">
					<ChartBarTrendUpIcon className="size-3.5 text-muted-foreground" />
					<h2 className="text-xs font-medium">Traces behind “{eventName}”</h2>
				</PanelHeader>
				<ErrorState
					error={error}
					title="Could not load traces for this event"
					variant="inline"
					className="px-3 py-2"
				/>
			</Panel>
		))
		.orElse(() => null)
}
