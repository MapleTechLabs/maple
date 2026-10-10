import * as React from "react"
import { FormDialog } from "@maple/ui/components/ui/form-dialog"
import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { Kbd } from "@maple/ui/components/ui/kbd"
import { CircleWarningIcon, MagnifierIcon } from "@/components/icons"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import { useAutocompleteValuesContextOptional } from "@/hooks/use-autocomplete-values"
import { useAppHotkey } from "@/hooks/use-app-hotkey"
import { parseWhereClause } from "@/lib/traces/advanced-filter-sync"

interface AdvancedFilterDialogProps {
	initialValue: string
	onApply: (value: string) => void
}

export function AdvancedFilterDialog({ initialValue, onApply }: AdvancedFilterDialogProps) {
	const [open, setOpenState] = React.useState(false)
	const [value, setValue] = React.useState(initialValue)
	const autocompleteValues = useAutocompleteValuesContextOptional()

	// Kick off the lazy autocomplete fetches while the dialog animates open so
	// values are ready by the time the editor is focused.
	const setOpen = (next: boolean) => {
		if (next) autocompleteValues?.activate?.()
		setOpenState(next)
	}

	React.useEffect(() => {
		if (open) {
			setValue(initialValue)
		}
	}, [open, initialValue])

	useAppHotkey("filter.advanced", () => setOpen(true))

	// Cmd+Enter to apply when the modal is open — form-scoped, so it stays a
	// plain listener instead of a registry shortcut.
	React.useEffect(() => {
		if (!open) return
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				onApply(value)
				setOpen(false)
			}
		}
		window.addEventListener("keydown", handleKeyDown)
		return () => window.removeEventListener("keydown", handleKeyDown)
	}, [open, value, onApply])

	const handleApply = () => {
		onApply(value)
		setOpen(false)
	}

	const handleClear = () => {
		setValue("")
		onApply("")
		setOpen(false)
	}

	const hasActiveFilter = initialValue.trim().length > 0
	// Clauses the trace list cannot apply are named here rather than silently dropped.
	const warnings = React.useMemo(() => parseWhereClause(value).warnings, [value])

	return (
		<>
			<Button
				variant={hasActiveFilter ? "secondary" : "outline"}
				className="gap-2"
				data-shortcut-focus="search"
				onClick={() => setOpen(true)}
			>
				<MagnifierIcon className={hasActiveFilter ? "text-primary" : "text-muted-foreground"} />
				<span>Advanced filter</span>
				<Kbd>F</Kbd>
			</Button>
			<FormDialog
				open={open}
				onOpenChange={setOpen}
				className="sm:max-w-3xl"
				panelClassName="space-y-0"
				title="Advanced filter"
				description={
					<>
						Write SQL-like queries to filter traces. Use <Kbd>Ctrl+Space</Kbd> for autocomplete.
						Press <Kbd>Cmd+Enter</Kbd> to apply.
					</>
				}
				onSubmit={handleApply}
				submitLabel="Apply filter"
				footerStart={
					<Button variant="ghost" onClick={handleClear} className="text-muted-foreground">
						Clear filter
					</Button>
				}
			>
				<WhereClauseEditor
					className="w-full"
					rows={8}
					value={value}
					dataSource="traces"
					autocompleteScope="trace_search"
					maxSuggestions={20}
					onChange={setValue}
					placeholder='service.name = "checkout" AND attr.http.route != "/health"'
					textareaClassName="font-mono text-sm leading-relaxed resize-y min-h-[200px] max-h-[40vh]"
					ariaLabel="Advanced traces where clause"
				/>
				{warnings.length > 0 && (
					<Alert variant="warn" size="sm" className="mt-2">
						<CircleWarningIcon size={14} />
						<AlertDescription className="text-severity-warn">
							<ul className="space-y-1">
								{warnings.map((warning) => (
									<li key={warning}>{warning}</li>
								))}
							</ul>
						</AlertDescription>
					</Alert>
				)}
			</FormDialog>
		</>
	)
}
