import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/** `BareInput`: a text input with no box of its own, for a field whose box is drawn around it (a tag editor's draft beside its chips). */
export type BareInputOptions<M> = Readonly<{
	id?: string
	className?: string
	attributes?: ReadonlyArray<Attribute<M>>
}>

const BASE = "min-w-0 bg-transparent outline-none placeholder:text-foreground-subtle"

export const bareInput = <M>(h: HtmlBuilder<M>, options: BareInputOptions<M>): Html =>
	h.input([
		...(options.id === undefined ? [] : [h.Id(options.id)]),
		...(options.attributes ?? []),
		h.Class(cn(BASE, options.className)),
		h.DataAttribute("slot", "bare-input"),
	])
