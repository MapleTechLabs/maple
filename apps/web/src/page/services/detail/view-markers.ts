import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PlotGeometry } from "../../../charts/chart"
import { truncatedText } from "../../../ui/truncated-text"
import type { MarkerLayout } from "./derive-markers"

// Commit markers over a chart, idle.
// TODO(marker-cards): hovering a dash or label (active styling, the commit card after 1.5 s / 400 ms)
// is not ported; the markers render in their idle state.

const LABEL_HEIGHT = 18
const LABEL_GAP = 4
const DASH_HIT = 5

const px = (value: number) => `${value}px`

/** `labelGap` lifts the labels clear of the plot, into a gutter the chart reserves above it. */
export const markersOverlay = <M>(
	h: HtmlBuilder<M>,
	layout: MarkerLayout,
	plot: PlotGeometry,
	labelGap: number = LABEL_GAP,
): Html =>
	layout.groups.length === 0
		? null
		: h.div(
				[
					h.DataAttribute("commit-markers", ""),
					h.Class(cn("absolute inset-0", "pointer-events-none")),
				],
				layout.groups.flatMap((group) => {
					const labelTop = plot.y - LABEL_HEIGHT - labelGap
					const dashTop = layout.labeled ? plot.y - labelGap : plot.y
					const dashHeight = layout.labeled ? Math.max(plot.height + labelGap, 0) : plot.height
					const badge = group.commits.length - 1
					const dashes = group.dashXs.map((x, index) =>
						h.div(
							[
								h.Key(`${group.key}-dash-${index}`),
								h.DataAttribute("commit-marker-dash", ""),
								h.Class("pointer-events-auto"),
								h.Style({
									position: "absolute",
									left: px(x - DASH_HIT),
									top: px(dashTop),
									width: px(DASH_HIT * 2),
									height: px(dashHeight),
									display: "flex",
									"justify-content": "center",
								}),
							],
							[
								h.div([
									h.Style({
										width: "0px",
										height: "100%",
										"border-left": "1px dashed var(--muted-foreground)",
										opacity: "0.4",
										transition: "opacity 120ms ease, border-color 120ms ease",
									}),
								]),
							],
						),
					)
					const anchor = h.span([
						h.Key(`${group.key}-anchor`),
						h.Style({
							position: "absolute",
							top: px(plot.y),
							left: px(group.boxLeft + group.boxWidth / 2),
							width: "0px",
							height: "0px",
						}),
					])
					const label = h.div(
						[
							h.Key(`${group.key}-label`),
							h.DataAttribute("commit-marker-label", ""),
							h.Style({
								position: "absolute",
								left: px(group.boxLeft),
								top: px(labelTop),
								width: px(group.boxWidth),
								height: px(LABEL_HEIGHT),
							}),
							h.Class(
								cn(
									"pointer-events-auto flex cursor-pointer items-center justify-center gap-1 rounded-[5px] border px-1.5 font-mono text-2xs leading-none backdrop-blur-sm transition-colors",
									"border-border-subtle bg-popover/85 text-muted-foreground hover:text-popover-foreground",
								),
							),
						],
						[
							truncatedText(h, { text: group.label }, [group.label]),
							...(badge > 0
								? [
										h.span(
											[
												h.Class(
													cn(
														"shrink-0 rounded-[3px] px-1 text-3xs tabular-nums",
														"bg-surface-strong text-muted-foreground",
													),
												),
											],
											[`+${Math.min(badge, 99)}`],
										),
									]
								: []),
						],
					)
					return [...dashes, anchor, ...(layout.labeled ? [label] : [])]
				}),
			)
