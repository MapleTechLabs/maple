export type StatFigureSize = "sm" | "md" | "lg"

export const statFigureValueSizeStyles: Record<StatFigureSize, string> = {
	sm: "text-xl",
	md: "text-2xl tracking-tight",
	lg: "text-[26px] tracking-[-0.01em]",
} satisfies Record<StatFigureSize, string>

export const statFigureUnitSizeStyles: Record<StatFigureSize, string> = {
	sm: "text-2xs",
	md: "text-xs",
	lg: "text-2xs",
} satisfies Record<StatFigureSize, string>

export const statFigureStyles = "flex items-baseline gap-1.5 whitespace-nowrap"

export const statFigureValueStyles = "font-semibold tabular-nums leading-none"

export const statFigureValueMonoStyles = "font-mono"

export const statFigureValueDisplayStyles = "font-display"

export const statFigureUnitStyles = "text-muted-foreground"

// The KPI anatomy around a figure: label above, the value, then an optional caption.
export const statFigureBlockStyles = "flex min-w-0 flex-col gap-2"

export const statFigureLabelStyles = "truncate text-xs font-medium text-muted-foreground"

export const statFigureCaptionStyles = "truncate text-xs text-muted-foreground"
