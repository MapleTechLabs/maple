// Shared empty / error placeholders so every view reads the same way.

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
			<p className="text-sm font-medium text-foreground">{title}</p>
			{hint ? <p className="max-w-sm text-sm text-muted-foreground">{hint}</p> : null}
		</div>
	)
}

export function ErrorState({ label, error }: { label: string; error: unknown }) {
	return (
		<div className="p-6 text-sm text-destructive">
			Failed to load {label}: {error instanceof Error ? error.message : String(error)}
		</div>
	)
}
