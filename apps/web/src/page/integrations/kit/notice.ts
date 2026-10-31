import type { Html, HtmlBuilder } from "foldkit/html"
import { panel } from "../../../ui/panel"

/** One line of integration state ("Railway is not connected.") with an optional trailing action. */
export const integrationNotice = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ message: Html | string; action?: Html | undefined }>,
): Html =>
	panel(h, { padded: true, className: "flex-row items-center justify-between gap-4 text-sm" }, [
		h.span([h.Class("text-muted-foreground")], [options.message]),
		...(options.action === undefined ? [] : [options.action]),
	])
