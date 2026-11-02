import type { Html, HtmlBuilder } from "foldkit/html"
import { vstack } from "../../ui/stack"

/** A detail side panel's frame (span, service, database): a full-height clipped column on the page background. */
export const sidePanelFrame = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	vstack(h, { className: "h-full bg-background overflow-hidden" }, children)
