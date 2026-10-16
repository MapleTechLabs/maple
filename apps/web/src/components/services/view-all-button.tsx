/** Primary text link that jumps from an overview card to the full tab. */
export function ViewAllButton({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
		>
			View all →
		</button>
	)
}
