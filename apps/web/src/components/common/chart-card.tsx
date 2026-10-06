import type { ComponentProps, ReactNode } from "react"
import { Panel, PanelHeader, PanelTitle } from "@maple/ui/components/ui/panel"
import { ChartEmpty } from "@maple/ui/components/charts"
import { cn } from "@maple/ui/lib/utils"

/** Every infra detail chart plots at this height, so a grid of them never staggers. */
export const CHART_HEIGHT = 200

/** Shown when a series query returns no points for the selected window. */
export const CHART_EMPTY_MESSAGE = "No data for this metric in the selected window."

/**
 * Card frame shared by every app chart: title on the left, legend on the right,
 * and an optional scope marker next to the title saying what the panel is
 * actually filtered to (see `ScopeChip` / Cloudflare's `PanelScope`).
 */
export function ChartCard({
	title,
	description,
	legend,
	scope,
	bare = false,
	children,
	className,
	...rest
}: Omit<ComponentProps<"section">, "title"> & {
	title: ReactNode
	/** A muted line under the title, for a chart whose title alone does not say what it plots. */
	description?: ReactNode
	/**
	 * Optional: a single-series chart whose series is named by the title has
	 * nothing to disambiguate. Multi-series charts should still pass one.
	 */
	legend?: ReactNode
	/** Scope marker: what this panel is actually filtered to. */
	scope?: ReactNode
	/** Drops the card border, for a chart that is a section of a page already divided by hairlines. */
	bare?: boolean
	children: ReactNode
	className?: string
}) {
	const header = (
		<PanelHeader
			title={title}
			scope={scope}
			action={legend}
			divided={false}
			className={cn("px-3 pt-2.5", bare && "px-0 pt-0")}
		>
			{description === undefined ? undefined : (
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<PanelTitle>{title}</PanelTitle>
						{scope}
					</div>
					<p className="text-2xs text-muted-foreground/70">{description}</p>
				</div>
			)}
		</PanelHeader>
	)
	if (bare) {
		return (
			<section className={cn("flex min-w-0 flex-col", className)} {...rest}>
				{header}
				{children}
			</section>
		)
	}
	return (
		<Panel className={className} {...rest}>
			{header}
			{children}
		</Panel>
	)
}

/**
 * Centered message filling an infra card's plot area: "no data", "not
 * collected", and friends. A thin alias over {@link ChartEmpty} that supplies
 * the card height; the look lives in the shared primitive.
 */
export function ChartCardMessage({ children }: { children: ReactNode }) {
	return <ChartEmpty height={CHART_HEIGHT}>{children}</ChartEmpty>
}
