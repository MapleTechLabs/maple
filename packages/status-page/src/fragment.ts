import type { StatusPagePublicSnapshot } from "@maple/domain/status-page"
import { Array as Arr } from "effect"
import { type RenderOptions, renderDocument, renderHeader } from "./document"
import { pageTitle } from "./format"
import { renderFooter, renderPageHero, renderSystemStatus } from "./page"
import { pageStyles } from "./styles"
import { SUBSCRIBE_LINK } from "./subscribe"

/** A part of the public page a fragment can show. */
export type FragmentPart = "header" | "hero" | "components" | "footer"

/** Drops the page's outer spacing so a small frame shows the part edge to edge. */
const FRAGMENT_STYLES = `.wrap{padding:16px}.top{margin-bottom:0}.wrap>section:first-child,.wrap>.panel:first-child{margin-top:0}.wrap>*+*{margin-top:16px}footer{margin-top:0}`

/**
 * A complete document with the page's own styles and theme but only `parts`, in order: the
 * dashboard's small previews of one setting. `componentId` narrows the components to one, under
 * its group's head. No script runs: nothing in it pages or opens.
 */
export const renderFragment = (
	snapshot: StatusPagePublicSnapshot,
	input: Readonly<{ parts: ReadonlyArray<FragmentPart>; nowMs: number; componentId?: string }>,
	options: RenderOptions = {},
): string => {
	const isPublic = snapshot.page.visibility === "public"
	const render = (part: FragmentPart): string => {
		switch (part) {
			case "header":
				return renderHeader(snapshot, options, isPublic ? SUBSCRIBE_LINK : "")
			case "hero":
				return renderPageHero(snapshot)
			case "components":
				return renderSystemStatus(snapshot, options, input.componentId)
			case "footer":
				return renderFooter(snapshot, { _tag: "live", updatedAt: input.nowMs }, input.nowMs, options)
		}
	}
	return renderDocument({
		snapshot,
		options,
		title: pageTitle(snapshot.page.name),
		styles: `${pageStyles}${FRAGMENT_STYLES}`,
		body: Arr.join(Arr.map(input.parts, render), ""),
		head: `<meta name="robots" content="noindex">`,
	})
}
