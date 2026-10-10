import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "@maple/ui/lib/utils"

interface InlineEditableTextProps {
	value: string
	onChange: (value: string) => void
	readOnly?: boolean
	className?: string
	inputClassName?: string
	ariaLabel: string
	/** Start in edit mode — used when a group or tab is created and wants naming. */
	autoEdit?: boolean
	/** Controlled edit state, for a parent that starts editing itself (F2 on a tab). */
	editing?: boolean
	onEditingChange?: (editing: boolean) => void
	/**
	 * `false` when rendered inside another control (the tab button): a focusable
	 * role="button" can't nest in a button, so the parent owns the keyboard path.
	 */
	focusable?: boolean
}

/**
 * Small inline renamer for section and tab titles.
 *
 * Deliberately separate from `InlineEditableTitle`, which hardcodes the page
 * heading's `text-2xl font-bold` and renders an `<h1>`. Generalising that one to
 * serve both would have put the dashboard's page title one prop away from
 * rendering at section size.
 *
 * Starts on double-click, or Enter/F2 when focused. Commits on Enter and on blur; Escape reverts. An empty or whitespace-only
 * value is discarded rather than saved — an untitled group is unclickable.
 */
export function InlineEditableText({
	value,
	onChange,
	readOnly = false,
	className,
	inputClassName,
	ariaLabel,
	autoEdit = false,
	editing,
	onEditingChange,
	focusable = true,
}: InlineEditableTextProps) {
	const [localEditing, setLocalEditing] = useState(autoEdit && !readOnly)
	const isEditing = editing ?? localEditing
	const setIsEditing = useCallback(
		(next: boolean) => {
			setLocalEditing(next)
			onEditingChange?.(next)
		},
		[onEditingChange],
	)
	const [draft, setDraft] = useState(value)
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		if (isEditing) inputRef.current?.select()
	}, [isEditing])

	const startEditing = useCallback(() => {
		if (readOnly) return
		setDraft(value)
		setIsEditing(true)
	}, [readOnly, value, setIsEditing])

	const commit = () => {
		const trimmed = draft.trim()
		if (trimmed && trimmed !== value) onChange(trimmed)
		setIsEditing(false)
	}

	if (isEditing && !readOnly) {
		return (
			<input
				ref={inputRef}
				value={draft}
				aria-label={ariaLabel}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault()
						commit()
					} else if (event.key === "Escape") {
						event.preventDefault()
						setDraft(value)
						setIsEditing(false)
					}
					// The grid and the tab bar both listen for these; while typing a
					// title they belong to the input.
					event.stopPropagation()
				}}
				// Stops a double-click-to-rename from also reaching the tab button.
				onClick={(event) => event.stopPropagation()}
				className={cn(
					"min-w-0 border-b border-foreground/20 bg-transparent outline-none focus:border-foreground/50",
					className,
					inputClassName,
				)}
			/>
		)
	}

	const keyboardRename = !readOnly && focusable
	return (
		<span
			onDoubleClick={startEditing}
			className={cn(className, !readOnly && "cursor-text")}
			title={readOnly ? value : `${value}\nDouble-click to rename`}
			tabIndex={keyboardRename ? 0 : undefined}
			role={keyboardRename ? "button" : undefined}
			aria-label={keyboardRename ? ariaLabel : undefined}
			onKeyDown={
				keyboardRename
					? (event) => {
							if (event.key === "Enter" || event.key === "F2") {
								event.preventDefault()
								startEditing()
							}
						}
					: undefined
			}
		>
			{value}
		</span>
	)
}
