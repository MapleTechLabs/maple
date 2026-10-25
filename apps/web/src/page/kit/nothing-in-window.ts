import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyTitle } from "../../ui/empty"

// `NothingInWindow`, shared by the Code Review and Security tabs.

/** The empty state of a tab whose filters left nothing: one way back to everything. */
export const nothingInWindow = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ title: string; description: string; onClear?: M | undefined }>,
): Html =>
	empty(
		h,
		[
			emptyHeader(h, [emptyTitle(h, [options.title]), emptyDescription(h, [options.description])]),
			...(options.onClear === undefined
				? []
				: [
						button(
							h,
							{ variant: "outline", size: "sm", attributes: [h.OnClick(options.onClear)] },
							["Clear filters"],
						),
					]),
		],
		"rounded-md border border-dashed md:py-14",
	)
