import { useRef, useCallback, useState } from "react"

export function InlineEditableTitle({
	value,
	onChange,
	readOnly = false,
}: {
	value: string
	onChange: (name: string) => void
	readOnly?: boolean
}) {
	const [isEditing, setIsEditing] = useState(false)
	const [draft, setDraft] = useState(value)
	const inputRef = useRef<HTMLInputElement>(null)

	const startEditing = useCallback(() => {
		if (readOnly) return
		setDraft(value)
		setIsEditing(true)
		requestAnimationFrame(() => inputRef.current?.select())
	}, [readOnly, value])

	const handleSubmit = () => {
		const trimmed = draft.trim()
		if (trimmed && trimmed !== value) {
			onChange(trimmed)
		}
		setIsEditing(false)
	}

	if (isEditing && !readOnly) {
		return (
			<form
				onSubmit={(e) => {
					e.preventDefault()
					handleSubmit()
				}}
			>
				<input
					ref={inputRef}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={handleSubmit}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							setDraft(value)
							setIsEditing(false)
						}
					}}
					className="font-display text-2xl font-semibold tracking-tight leading-[1.1] bg-transparent border-b border-foreground/20 outline-none focus:border-foreground/50 w-full"
				/>
			</form>
		)
	}

	return (
		<h1
			role="button"
			tabIndex={0}
			onClick={startEditing}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					startEditing()
				}
			}}
			aria-disabled={readOnly}
			className={
				readOnly
					? "font-display text-2xl font-semibold tracking-tight truncate leading-[1.1]"
					: "font-display text-2xl font-semibold tracking-tight truncate leading-[1.1] cursor-pointer hover:text-foreground/80"
			}
		>
			{value}
		</h1>
	)
}
