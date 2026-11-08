import type { Html, HtmlBuilder } from "foldkit/html"
import { panel } from "@maple/views/ui/panel"
import { typography } from "@maple/views/ui/typography"

/** One line of integration state ("Railway is not connected.") with an optional trailing action. */
export const integrationNotice = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ message: Html | string; action?: Html | undefined }>,
): Html =>
	panel(h, { padded: true, className: "flex-row items-center justify-between gap-4 text-sm" }, [
		typography(h, { tone: "muted" }, [options.message]),
		...(options.action === undefined ? [] : [options.action]),
	])
