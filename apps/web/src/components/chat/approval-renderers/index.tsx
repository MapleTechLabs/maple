import { humanize } from "@/lib/humanize"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { asRecord } from "./parse"
import {
	AddDashboardWidgetSummary,
	CreateDashboardSummary,
	RemoveDashboardWidgetSummary,
	ReorderDashboardWidgetsSummary,
	UpdateDashboardSummary,
	UpdateDashboardWidgetSummary,
} from "./dashboard"
import { EMPTY_VALUE } from "@maple/ui/lib/format"

interface SummaryProps {
	toolName: string
	input: unknown
}

const RENDERERS: Record<string, React.ComponentType<{ input: unknown }>> = {
	create_dashboard: CreateDashboardSummary,
	update_dashboard: UpdateDashboardSummary,
	add_dashboard_widget: AddDashboardWidgetSummary,
	update_dashboard_widget: UpdateDashboardWidgetSummary,
	remove_dashboard_widget: RemoveDashboardWidgetSummary,
	reorder_dashboard_widgets: ReorderDashboardWidgetsSummary,
} satisfies Record<string, React.ComponentType<{ input: unknown }>>

export function ApprovalSummary({ toolName, input }: SummaryProps) {
	const Renderer = RENDERERS[toolName]
	if (Renderer) return <Renderer input={input} />
	return <KeyValueFallback input={input} />
}

function formatValue(value: unknown): { kind: "scalar"; text: string } | { kind: "blob"; chars: number } {
	if (value === null || value === undefined) return { kind: "scalar", text: EMPTY_VALUE }
	if (typeof value === "boolean") return { kind: "scalar", text: value ? "true" : "false" }
	if (typeof value === "number") return { kind: "scalar", text: String(value) }
	if (typeof value === "string") {
		if (value.length > 200) return { kind: "blob", chars: value.length }
		return { kind: "scalar", text: value }
	}
	try {
		const json = JSON.stringify(value)
		if (json.length > 200) return { kind: "blob", chars: json.length }
		return { kind: "scalar", text: json }
	} catch {
		return { kind: "scalar", text: String(value) }
	}
}

function KeyValueFallback({ input }: { input: unknown }) {
	const obj = asRecord(input)
	if (!obj) {
		return (
			<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-2xs leading-snug">
				{safeStringify(input)}
			</pre>
		)
	}

	const entries = Object.entries(obj).filter(
		([, value]) => value !== undefined && value !== null && value !== "",
	)

	if (entries.length === 0) {
		return <div className="text-xs text-muted-foreground">No input fields</div>
	}

	return (
		<KeyValueList layout="grid" className="gap-x-2 gap-y-1">
			{entries.map(([key, value]) => {
				const formatted = formatValue(value)
				return (
					<KeyValue key={key} label={humanize(key)}>
						{formatted.kind === "scalar" ? (
							<span className="font-medium">{formatted.text}</span>
						) : (
							<span className="text-muted-foreground italic">
								JSON · {formatted.chars} chars
							</span>
						)}
					</KeyValue>
				)
			})}
		</KeyValueList>
	)
}

export function safeStringify(input: unknown): string {
	try {
		return JSON.stringify(input, null, 2)
	} catch {
		return String(input)
	}
}
