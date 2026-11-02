import { cn } from "@maple/ui/lib/utils"
import { pageTitleStyles } from "@maple/ui/styles/ui/page-layout"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/** `InlineRenameInput`: the text input that stands in for a title while it is renamed, an underline with no box. */
export type InlineRenameInputOptions<M> = Readonly<{
	/** Draws the text in the page title's type, so the heading does not jump when it turns editable. */
	isPageTitle?: boolean
	className?: string
	attributes?: ReadonlyArray<Attribute<M>>
}>

const BASE = "min-w-0 border-b border-foreground/20 bg-transparent outline-none focus:border-foreground/50"

export const inlineRenameInput = <M>(h: HtmlBuilder<M>, options: InlineRenameInputOptions<M>): Html =>
	h.input([
		...(options.attributes ?? []),
		h.Class(cn(options.isPageTitle === true && pageTitleStyles, BASE, options.className)),
		h.DataAttribute("slot", "inline-rename-input"),
	])
