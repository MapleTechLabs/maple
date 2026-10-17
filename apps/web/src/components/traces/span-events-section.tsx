import type { SpanEvent } from "@maple/query-engine"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { ChevronRightIcon, CircleXmarkIcon } from "@/components/icons"
import { describeSpanEvent, formatEventOffset } from "@/lib/traces/span-events"

function EventAttributes({ attributes }: { attributes: Readonly<Record<string, string>> }) {
	const entries = Object.entries(attributes)
	if (entries.length === 0) return null
	return (
		<KeyValueList className="gap-0.5 text-2xs">
			{entries.map(([key, value]) => (
				<KeyValue key={key} mono wrap label={key} copyValue={value}>
					{value}
				</KeyValue>
			))}
		</KeyValueList>
	)
}

function SpanEventRow({ event }: { event: SpanEvent }) {
	const described = describeSpanEvent(event)
	const offset = (
		<span
			className="w-20 shrink-0 font-mono text-3xs tabular-nums text-muted-foreground"
			title={event.timestamp}
		>
			{formatEventOffset(event.offsetMs)}
		</span>
	)

	if (described.kind === "event") {
		return (
			<li className="space-y-1 p-2">
				<div className="flex min-w-0 items-baseline gap-2">
					{offset}
					<span className="min-w-0 truncate font-mono text-xs">{event.name || "(unnamed)"}</span>
				</div>
				<EventAttributes attributes={described.attributes} />
			</li>
		)
	}

	return (
		<li className="space-y-1 p-2">
			<div className="flex min-w-0 items-baseline gap-2">
				{offset}
				<span className="flex min-w-0 items-center gap-1 font-mono text-xs text-severity-error">
					<CircleXmarkIcon size={12} className="shrink-0 self-center" />
					<span className="truncate">{described.type ?? "exception"}</span>
				</span>
			</div>
			{described.message && (
				<p className="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
					{described.message}
				</p>
			)}
			{described.stacktrace && (
				<Collapsible>
					<div className="flex items-center gap-1">
						<CollapsibleTrigger className="group flex items-center gap-1 text-3xs text-muted-foreground transition-colors hover:text-foreground">
							<ChevronRightIcon
								size={10}
								className="transition-transform group-data-[panel-open]:rotate-90"
							/>
							Stack trace
						</CollapsibleTrigger>
						<CopyButton value={described.stacktrace} label="stack trace" iconSize={10} />
					</div>
					<CollapsibleContent>
						<pre className="mt-1 max-h-80 overflow-auto rounded-sm bg-muted/40 p-2 font-mono text-3xs leading-relaxed">
							{described.stacktrace}
						</pre>
					</CollapsibleContent>
				</Collapsible>
			)}
			<EventAttributes attributes={described.attributes} />
		</li>
	)
}

/** The span's OTel events in time order, with `exception` events expanded. */
export function SpanEventsSection({ events }: { events: ReadonlyArray<SpanEvent> }) {
	if (events.length === 0) return null
	return (
		<div className="space-y-1">
			<h4 className="text-xs font-medium text-muted-foreground">Events ({events.length})</h4>
			<ul className="divide-y rounded-md border">
				{events.map((event, index) => (
					<SpanEventRow key={`${event.timestamp}-${event.name}-${index}`} event={event} />
				))}
			</ul>
		</div>
	)
}
