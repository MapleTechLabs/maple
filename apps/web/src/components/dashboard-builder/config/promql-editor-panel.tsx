import { useDeferredValue, useState } from "react"
import { Effect, Exit } from "effect"
import { promQlStarterQuery } from "@maple/query-engine"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import {
	Combobox,
	ComboboxContent,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@maple/ui/components/ui/combobox"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"
import { Input } from "@maple/ui/components/ui/input"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { getGcpMetricDescriptor } from "@/api/warehouse/gcp-promql"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { displayError } from "@/lib/error-messages"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { gcpMetricSearchResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

/** The editor's form. `projects` stays the typed text until it is saved. */
export interface PromQlDraft {
	query: string
	projects: string
	legend: string
}

/** Project ids from the comma- or space-separated field; none means every project. */
export const parsePromQlProjects = (text: string): ReadonlyArray<string> =>
	text.split(/[\s,]+/u).filter((projectId) => projectId !== "")

interface PromQlEditorPanelProps {
	draft: PromQlDraft
	onDraftChange: (next: PromQlDraft) => void
	onRunPreview: () => void
	/** The preview's failure, e.g. Google's message for a query it refused. */
	error?: { title: string; message?: string }
}

export function PromQlEditorPanel({ draft, onDraftChange, onRunPreview, error }: PromQlEditorPanelProps) {
	const [search, setSearch] = useState("")
	const deferredSearch = useDeferredValue(search.trim())
	const searchResult = useAtomValue(
		deferredSearch === ""
			? disabledResultAtom()
			: gcpMetricSearchResultAtom({ data: { search: deferredSearch } }),
	)
	const metrics = Result.builder(searchResult)
		.onSuccess((response) => (response as { metrics: ReadonlyArray<string> }).metrics)
		.orElse((): ReadonlyArray<string> => [])

	const [starterError, setStarterError] = useState<string | null>(null)
	const [insertStarter, inserting] = useAsyncAction(async (metric: string) => {
		setStarterError(null)
		const exit = await Effect.runPromiseExit(getGcpMetricDescriptor(metric))
		if (Exit.isFailure(exit)) {
			setStarterError(displayError(exit.cause).message)
			return
		}
		onDraftChange({ ...draft, query: promQlStarterQuery(metric, exit.value) })
	})

	return (
		<div className="space-y-3">
			<div className="border rounded-md">
				<div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
					<Badge
						variant="outline"
						className="font-mono text-2xs text-white border-0 shrink-0 bg-primary/80"
					>
						promql
					</Badge>
					<span className="text-2xs text-muted-foreground shrink-0">
						Google Cloud Monitoring, live
					</span>
					<div className="flex-1" />
					{error && (
						<span
							className={cn("text-2xs truncate", TONE_TEXT.crit)}
							title={error.message ?? error.title}
						>
							{error.title}
						</span>
					)}
				</div>

				<div className="p-3 space-y-3">
					<Field className="gap-1.5">
						<FieldLabel className="font-normal text-2xs text-muted-foreground">
							Start from a metric: picking one replaces the query below
						</FieldLabel>
						<Combobox<string | null>
							value={null}
							onValueChange={(metric) => {
								if (typeof metric === "string") void insertStarter(metric)
							}}
						>
							<ComboboxInput
								placeholder={
									inserting
										? "Writing a starter query..."
										: "Search metrics, e.g. run.googleapis.com"
								}
								className="h-8 text-xs"
								disabled={inserting}
								onChange={(e) => setSearch(e.target.value)}
							/>
							<ComboboxContent>
								{metrics.length === 0 ? (
									<EmptyMessage className="px-3 py-4">
										{deferredSearch === ""
											? "Type part of a metric name."
											: `No metric name contains "${deferredSearch}".`}
									</EmptyMessage>
								) : (
									<ComboboxList>
										{metrics.map((metric) => (
											<ComboboxItem
												key={metric}
												value={metric}
												className="font-mono text-xs"
											>
												{metric}
											</ComboboxItem>
										))}
									</ComboboxList>
								)}
							</ComboboxContent>
						</Combobox>
						{starterError !== null && (
							<span className={cn("text-2xs", TONE_TEXT.crit)}>{starterError}</span>
						)}
					</Field>

					<textarea
						aria-label="PromQL query"
						value={draft.query}
						onChange={(e) => onDraftChange({ ...draft, query: e.target.value })}
						spellCheck={false}
						placeholder={'sum by (service) (rate({"run.googleapis.com/request_count"}[5m]))'}
						className="w-full bg-transparent font-mono text-xs leading-5 border border-border rounded-sm px-2 py-1.5 min-h-[120px] resize-y outline-none focus:ring-1 focus:ring-foreground/20"
					/>
					{error?.message && (
						<p
							className={cn(
								"font-mono text-2xs whitespace-pre-wrap break-words",
								TONE_TEXT.crit,
							)}
						>
							{error.message}
						</p>
					)}

					<div className="grid grid-cols-2 gap-3">
						<Field className="gap-1.5">
							<FieldLabel className="font-normal text-2xs text-muted-foreground">
								Projects (empty: every project, up to 20)
							</FieldLabel>
							<Input
								value={draft.projects}
								onChange={(e) => onDraftChange({ ...draft, projects: e.target.value })}
								placeholder="shop-prod, shop-staging"
								className="h-8 font-mono text-xs"
							/>
						</Field>
						<Field className="gap-1.5">
							<FieldLabel className="font-normal text-2xs text-muted-foreground">
								Legend (labels as {"{{label}}"})
							</FieldLabel>
							<Input
								value={draft.legend}
								onChange={(e) => onDraftChange({ ...draft, legend: e.target.value })}
								placeholder="{{service}}"
								className="h-8 font-mono text-xs"
							/>
						</Field>
					</div>
				</div>
			</div>

			<div className="flex items-center gap-3">
				<Button size="sm" onClick={onRunPreview} disabled={draft.query.trim() === ""}>
					Run preview
				</Button>
				<span className="text-2xs text-muted-foreground ml-auto">
					Google bills the series a read returns to your project.
				</span>
			</div>
		</div>
	)
}
