/** avg → peak. One number can't distinguish a steady 60% from a spike to 100%. */
export function AvgPeak({ avg, peak, format }: { avg: number; peak: number; format: (n: number) => string }) {
	return (
		<span className="font-mono text-2xs tabular-nums text-foreground">
			<span className="text-muted-foreground">{format(avg)}</span>
			<span className="mx-1 text-foreground/30">→</span>
			{format(peak)}
		</span>
	)
}
