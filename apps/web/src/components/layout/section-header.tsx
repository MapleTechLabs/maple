export function SectionHeader({ id, label }: { id: string; label: string }) {
	return (
		<h2
			id={id}
			className="mb-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
		>
			{label}
		</h2>
	)
}
