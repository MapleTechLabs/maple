import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/** `FileInput`: a hidden `<input type="file">` that a visible button opens by id; it reports the picked files. */
export type FileInputOptions<M> = Readonly<{
	id: string
	/** Accessible name, for when it is opened without its button. */
	label: string
	/** The `accept` filter (`.json`, `image/*`). */
	accept?: string
	onChange: (files: ReadonlyArray<File>) => M
	className?: string
	attributes?: ReadonlyArray<Attribute<M>>
}>

export const fileInput = <M>(h: HtmlBuilder<M>, options: FileInputOptions<M>): Html =>
	h.input([
		...(options.accept === undefined ? [] : [h.Accept(options.accept)]),
		h.AriaLabel(options.label),
		h.Class(cn("hidden", options.className)),
		h.Type("file"),
		h.Id(options.id),
		h.DataAttribute("slot", "file-input"),
		h.OnFileChange(options.onChange),
		...(options.attributes ?? []),
	])
