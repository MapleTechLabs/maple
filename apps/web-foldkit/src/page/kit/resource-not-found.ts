import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../ui/empty"
import { icon } from "../../ui/icon"

// Port of `ResourceNotFound` (apps/web/src/components/common/resource-not-found.tsx).

export const resourceNotFound = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		title: string
		description?: string
		back?: Readonly<{ href: string; label: string }>
		className?: string
	}>,
): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "CircleWarningIcon", { size: 18 })]),
				emptyTitle(h, [options.title]),
				...(options.description === undefined ? [] : [emptyDescription(h, [options.description])]),
			]),
			...(options.back === undefined
				? []
				: [linkButton(h, { variant: "outline", size: "sm", href: options.back.href }, [options.back.label])]),
		],
		cn("md:py-12", options.className),
	)
