import { AttributesPanelComposition } from "@maple/web/ui/attributes/attributes-panel"
import { attributesSection } from "@maple/web/ui/attributes/attributes-view"
import { skeleton, skeletonList } from "@maple/web/ui/skeleton"
import type { Html, HtmlBuilder } from "foldkit/html"

// The span panel's attribute blocks: `AttributesSection` / `ResourceAttributesSection`, grouped by
// namespace. Each block is an alternate view of the attributes panel Block, so they stay direct
// children of the Details body.

export type SectionInputs = Readonly<{
	attributes: Readonly<Record<string, string>>
	title: string
	section: string
}>

export const sectionView = AttributesPanelComposition.makeView.withInputs<SectionInputs>((model, inputs, h) =>
	attributesSection(
		h,
		{ model, source: "log", canFilter: false, idPrefix: inputs.section, hasCommitShaValues: false },
		{ attributes: inputs.attributes, title: inputs.title, section: inputs.section, isGrouped: true },
	),
)

/** While the full attribute maps load. */
export const attributesPending = <M>(h: HtmlBuilder<M>): Html =>
	skeletonList(h, {
		rows: 4,
		gap: "2",
		renderRow: (index) => skeleton(h, index % 2 === 0 ? "h-4 w-32" : "h-24 w-full"),
	})

/** The full-attribute lookup failed: the trimmed maps follow. */
export const attributesFailedNote = <M>(h: HtmlBuilder<M>): Html =>
	h.p(
		[h.Class("rounded-md border border-dashed px-2 py-1.5 text-[11px] text-muted-foreground")],
		["Couldn't load all attributes. Showing the ones loaded with the trace."],
	)
