import type {
	CLSMetricWithAttribution,
	INPMetricWithAttribution,
	LCPMetricWithAttribution,
} from "web-vitals/attribution"

/**
 * Which part of the app shell a vital's element sits in. The shell components already name
 * themselves with `data-slot`, so this reads those rather than adding a parallel attribute.
 * `detached` means the element was gone from the DOM by the time the vital reported.
 */
export type PerfRegion =
	| "sidebar"
	| "topbar"
	| "filters"
	| "page-header"
	| "content"
	| "right-panel"
	| "overlay"
	| "shell"
	| "other"
	| "detached"

const REGION_BY_SLOT = new Map<string, PerfRegion>([
	["sidebar", "sidebar"],
	["app-topbar", "topbar"],
	["page-filter-sidebar", "filters"],
	["page-right-sidebar", "right-panel"],
	["page-sticky-area", "page-header"],
	["page-header", "page-header"],
	["page-scroll-area", "content"],
	["page-fill", "content"],
	["page-content", "content"],
	// Direct children of the layout that no inner slot claims: the app banners.
	["page-layout", "shell"],
])

const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'
const REGION_SELECTOR = [
	OVERLAY_SELECTOR,
	...[...REGION_BY_SLOT.keys()].map((slot) => `[data-slot="${slot}"]`),
].join(", ")

export function regionOf(node: Node | null | undefined): PerfRegion {
	if (!node || !node.isConnected) return "detached"
	const element = node instanceof Element ? node : node.parentElement
	// The nearest match wins, so a page header inside `page-content` reads as `page-header`.
	const match = element?.closest(REGION_SELECTOR)
	if (!match) return "other"
	if (match.matches(OVERLAY_SELECTOR)) return "overlay"
	return REGION_BY_SLOT.get(match.getAttribute("data-slot") ?? "") ?? "other"
}

export type VitalWithAttribution =
	| CLSMetricWithAttribution
	| INPMetricWithAttribution
	| LCPMetricWithAttribution

type AttributeValue = string | number | boolean
export type VitalAttributes = { region: PerfRegion; attributes: Record<string, AttributeValue> }

const ms = (value: number | undefined): number | undefined =>
	value === undefined ? undefined : Math.round(value)

function defined(attributes: Record<string, AttributeValue | undefined>): Record<string, AttributeValue> {
	const out: Record<string, AttributeValue> = {}
	for (const [key, value] of Object.entries(attributes)) if (value !== undefined) out[key] = value
	return out
}

/** The region a vital happened in, plus the `maple.vital.*` breakdown web-vitals attributes to it. */
export function vitalAttribution(metric: VitalWithAttribution): VitalAttributes {
	switch (metric.name) {
		case "CLS": {
			const a = metric.attribution
			const region = regionOf(a.largestShiftSource?.node)
			return {
				region,
				attributes: defined({
					"maple.vital.region": region,
					"maple.vital.target": a.largestShiftTarget,
					// `loading` → `complete`: whether the page was still loading when it shifted.
					"maple.vital.load_state": a.loadState,
					"maple.vital.largest_shift_value": a.largestShiftValue,
					"maple.vital.largest_shift_time_ms": ms(a.largestShiftTime),
				}),
			}
		}
		case "INP": {
			const a = metric.attribution
			const region = regionOf(a.processedEventEntries[0]?.target)
			return {
				region,
				attributes: defined({
					"maple.vital.region": region,
					"maple.vital.target": a.interactionTarget || undefined,
					"maple.vital.load_state": a.loadState,
					"maple.vital.interaction_type": a.interactionType,
					"maple.vital.input_delay_ms": ms(a.inputDelay),
					"maple.vital.processing_ms": ms(a.processingDuration),
					"maple.vital.presentation_delay_ms": ms(a.presentationDelay),
				}),
			}
		}
		case "LCP": {
			const a = metric.attribution
			const region = regionOf(a.lcpEntry?.element)
			return {
				region,
				attributes: defined({
					"maple.vital.region": region,
					"maple.vital.target": a.target,
					"maple.vital.ttfb_ms": ms(a.timeToFirstByte),
					"maple.vital.resource_load_delay_ms": ms(a.resourceLoadDelay),
					"maple.vital.resource_load_duration_ms": ms(a.resourceLoadDuration),
					"maple.vital.element_render_delay_ms": ms(a.elementRenderDelay),
				}),
			}
		}
	}
}
