import { cn } from "@maple/ui/lib/utils"
import { String as Str } from "effect"
import type { File } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Dialog from "@maple/views/ui/dialog"
import { separator } from "@maple/views/ui/display"
import { fileInput } from "@maple/views/ui/file-input"
import { formDialog } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import { input } from "@maple/views/ui/input"
import { label } from "@maple/views/ui/label"
import { pressable } from "@maple/views/ui/pressable"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"

// An image a user uploads or links (a logo, a favicon). The field previews it and opens the
// dialog; the dialog takes a picked or dropped file, or an https link. The parent owns the value,
// the dialog, the link draft and the drag state, and reads a picked file itself.

/** How the image is previewed: a logo in a page header, or a favicon in a browser tab. */
export type ImageSourcePreview =
	| Readonly<{ _tag: "Logo"; /** The page colour behind the logo, as visitors see it. */ background: string }>
	| Readonly<{ _tag: "Favicon"; /** The tab's title beside the icon. */ title: string }>

/** The hidden file input the dialog's drop zone opens. */
export const imageSourceInputId = (id: string): string => `${id}-file`

export type ImageSourceFieldOptions<M> = Readonly<{
	id: string
	label: string
	description: string
	/** An https URL, an uploaded `data:` URL, or empty. */
	value: string
	/** The value's problem, if any. */
	error: string | null
	preview: ImageSourcePreview
	accept: string
	isReadOnly: boolean
	onEdit: M
	onRemove: M
	onFiles: (files: ReadonlyArray<File.File>) => M
}>

/** A favicon in a browser window: its tab on the strip, joined to the page under it. */
const faviconPreview = <M>(h: HtmlBuilder<M>, value: string, title: string): Html =>
	vstack(h, { as: "span", className: "size-full" }, [
		hstack(h, { as: "span", align: "end", className: "h-10 shrink-0 px-3" }, [
			hstack(
				h,
				{
					gap: "2",
					align: "center",
					as: "span",
					className: "h-8 w-52 max-w-full rounded-t-md bg-background px-3",
				},
				[
					h.img([h.Src(value), h.Alt(""), h.Class("size-4 shrink-0 object-contain")]),
					typography(h, { size: "xs", truncate: true, className: "flex-1 text-left font-prose" }, [
						title,
					]),
					icon(h, "XmarkIcon", { className: "size-3 shrink-0 text-muted-foreground" }),
				],
			),
		]),
		hstack(h, { as: "span", align: "center", grow: true, className: "bg-background px-3" }, [
			// The address bar, as a quiet placeholder.
			h.span([h.Class("h-5 w-2/3 rounded-full bg-muted"), h.AriaHidden(true)], []),
		]),
	])

const previewOf = <M>(h: HtmlBuilder<M>, value: string, preview: ImageSourcePreview): Html =>
	preview._tag === "Favicon"
		? faviconPreview(h, value, preview.title)
		: // The public page's header height, so the preview is the logo at its real size.
			h.img([h.Src(value), h.Alt(""), h.Class("h-9 w-auto max-w-3/4 object-contain")])

/** A logo or favicon as visitors will see it; pressing it opens the dialog that changes it. */
export const imageSourceField = <M>(h: HtmlBuilder<M>, options: ImageSourceFieldOptions<M>): Html => {
	const hasImage = options.value !== "" && options.error === null
	const isFavicon = options.preview._tag === "Favicon"
	const name = Str.toLowerCase(options.label)
	const look = cn(
		"relative flex w-full items-center justify-center overflow-hidden rounded-lg border",
		"h-24",
		isFavicon && hasImage && "items-stretch bg-muted",
		!hasImage && "border-dashed text-muted-foreground",
	)
	const background =
		hasImage && options.preview._tag === "Logo"
			? [h.Style({ backgroundColor: options.preview.background })]
			: []
	const content = hasImage
		? [previewOf(h, options.value, options.preview)]
		: [
				hstack(h, { gap: "1.5", align: "center", as: "span" }, [
					icon(h, "PlusIcon", { className: "size-4" }),
					typography(h, { size: "xs", className: "font-prose" }, [`Add ${name}`]),
				]),
			]
	return vstack(h, { gap: "2", attributes: [h.Id(options.id)] }, [
		vstack(h, { gap: "0.5" }, [
			typography(h, { size: "sm", weight: "medium" }, [options.label]),
			typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
				options.description,
			]),
		]),
		options.isReadOnly
			? h.div([h.Class(look), ...background], content)
			: pressable(
					h,
					{
						onClick: options.onEdit,
						label: hasImage ? `Change ${name}` : `Add ${name}`,
						className: cn(look, "hover:border-border-strong active:border-border-strong"),
						attributes: background,
					},
					content,
				),
		...(options.error === null
			? []
			: [typography(h, { size: "xs", tone: "error", className: "font-prose" }, [options.error])]),
		...(options.isReadOnly || options.value === ""
			? []
			: [
					hstack(h, { gap: "3" }, [
						textLink(h, { tone: "muted", onClick: options.onEdit, className: "text-xs" }, ["Change"]),
						textLink(h, { tone: "muted", onClick: options.onRemove, className: "text-xs" }, ["Remove"]),
					]),
				]),
		fileInput(h, {
			id: imageSourceInputId(options.id),
			label: `Upload ${name}`,
			accept: options.accept,
			onChange: options.onFiles,
		}),
	])
}

export type ImageSourceDialogOptions<M> = Readonly<{
	slotId: string
	model: Dialog.Model
	toParentMessage: (message: Dialog.Message) => M
	title: string
	/** What a file may be ("PNG, SVG or ICO, up to 128 KB"). */
	formats: string
	link: string
	/** The typed link's problem, or `null`. */
	linkError: string | null
	linkPlaceholder: string
	isDragging: boolean
	onBrowse: M
	onFiles: (files: ReadonlyArray<File.File>) => M
	onDragOver: M
	onDragLeave: M
	onLinkInput: (value: string) => M
	onSubmitLink: M
}>

/** Upload, drop or link an image: a file applies at once, a link on submit. */
export const imageSourceDialog = <M>(h: HtmlBuilder<M>, options: ImageSourceDialogOptions<M>): Html => {
	const linkId = `${options.model.id}-link`
	return formDialog(h, {
		slotId: options.slotId,
		model: options.model,
		toParentMessage: options.toParentMessage,
		title: options.title,
		onSubmit: options.onSubmitLink,
		submitLabel: "Use link",
		isSubmitDisabled: Str.trim(options.link) === "" || options.linkError !== null,
		className: "sm:max-w-md",
		fields: [
			h.div(
				[
					h.OnDragOver(options.onDragOver),
					h.OnDragLeave(options.onDragLeave),
					h.AllowDrop(),
					h.OnDropFiles(options.onFiles),
				],
				[
					pressable(
						h,
						{
							onClick: options.onBrowse,
							label: "Upload an image",
							className: cn(
								"flex h-36 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 font-prose hover:bg-surface-sunken active:bg-surface-sunken",
								options.isDragging && "border-primary bg-primary-a2 ring-2 ring-primary",
							),
						},
						[
							icon(h, "UploadIcon", { className: "size-5 text-muted-foreground" }),
							options.isDragging
								? typography(h, { size: "sm", weight: "medium", tone: "primary" }, ["Drop to upload"])
								: typography(h, { size: "sm" }, [
										"Drop an image here or ",
										typography(h, { size: "sm", weight: "medium", tone: "primary" }, ["browse"]),
									]),
							typography(h, { size: "xs", tone: "muted" }, [options.formats]),
						],
					),
				],
			),
			hstack(h, { gap: "3", align: "center" }, [
				separator(h, "horizontal", "flex-1"),
				typography(h, { size: "xs", tone: "muted", className: "font-prose" }, ["or"]),
				separator(h, "horizontal", "flex-1"),
			]),
			vstack(h, { gap: "1.5" }, [
				label(h, { className: "text-xs", attributes: [h.For(linkId)] }, ["Link to an image"]),
				input(h, {
					id: linkId,
					type: "url",
					attributes: [
						h.Value(options.link),
						h.Placeholder(options.linkPlaceholder),
						h.OnInput(options.onLinkInput),
						h.Autocomplete("off"),
					],
				}),
				...(options.linkError === null
					? []
					: [typography(h, { size: "xs", tone: "error", className: "font-prose" }, [options.linkError])]),
			]),
		],
	})
}
