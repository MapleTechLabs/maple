import { cn } from "@maple/ui/lib/utils"
import { Option, String as Str } from "effect"
import type { File } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { fileInput } from "@maple/views/ui/file-input"
import { icon } from "@maple/views/ui/icon"
import { input } from "@maple/views/ui/input"
import { pressable } from "@maple/views/ui/pressable"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"

// The parent owns the value, the drag state and whether the link field is open, and reads a
// picked file itself (the field only reports it).

/** How the image is previewed: a logo in a page header, or a favicon in a browser tab. */
export type ImageSourcePreview =
	| Readonly<{ _tag: "Logo"; /** The page colour behind the logo, so it shows as visitors see it. */ background: string | null }>
	| Readonly<{ _tag: "Favicon"; /** The tab's title beside the icon. */ title: string }>

export type ImageSourceFieldOptions<M> = Readonly<{
	id: string
	label: string
	description: string
	/** An https URL, an uploaded `data:` URL, or empty. */
	value: string
	/** The value's problem, shown under the link field (which opens to show it). */
	error: string | null
	preview: ImageSourcePreview
	accept: string
	/** What the empty box says it takes ("PNG, SVG or ICO, up to 128 KB"). */
	formats: string
	isDragging: boolean
	isLinkOpen: boolean
	isReadOnly: boolean
	linkPlaceholder: string
	onPick: M
	onFiles: (files: ReadonlyArray<File.File>) => M
	onDragOver: M
	onDragLeave: M
	onRemove: M
	onToggleLink: M
	onLinkInput: (value: string) => M
}>

/** The hidden file input behind an image source field's box and Upload button. */
export const imageSourceInputId = (id: string): string => `${id}-file`

const hostOf = (value: string): Option.Option<string> =>
	URL.canParse(value) && new URL(value).protocol === "https:" ? Option.some(new URL(value).host) : Option.none()

const previewOf = <M>(h: HtmlBuilder<M>, options: ImageSourceFieldOptions<M>): Html => {
	const preview = options.preview
	if (preview._tag === "Favicon")
		return hstack(
			h,
			{
				gap: "2",
				align: "center",
				className: "w-56 max-w-full rounded-t-md border border-b-0 bg-background px-3 py-2 shadow-raised",
			},
			[
				h.img([h.Src(options.value), h.Alt(""), h.Class("size-4 shrink-0 object-contain")]),
				typography(h, { size: "xs", truncate: true, className: "flex-1" }, [preview.title]),
				icon(h, "XmarkIcon", { className: "size-3 shrink-0 text-muted-foreground" }),
			],
		)
	// The public page's header height, so the preview is the logo at its real size.
	return h.img([h.Src(options.value), h.Alt(""), h.Class("h-9 w-auto max-w-3/4 object-contain")])
}

/**
 * An image a user uploads or links (a logo, a favicon): a box that previews it as it will be
 * seen and takes a dropped or picked file, with Upload, Remove and an optional https link.
 */
export const imageSourceField = <M>(h: HtmlBuilder<M>, options: ImageSourceFieldOptions<M>): Html => {
	const hasImage = options.value !== "" && options.error === null
	const isInteractive = !options.isReadOnly
	const background =
		hasImage && options.preview._tag === "Logo" && options.preview.background !== null
			? [h.Style({ backgroundColor: options.preview.background })]
			: []
	const dropAttributes = isInteractive
		? [
				h.OnDragOver(options.onDragOver),
				h.OnDragLeave(options.onDragLeave),
				h.AllowDrop(),
				h.OnDropFiles(options.onFiles),
			]
		: []
	const box = h.div(
		[
			h.Class(
				cn(
					"relative flex items-center justify-center overflow-hidden rounded-lg border",
					options.preview._tag === "Favicon" && hasImage ? "h-14 items-end bg-muted" : "h-24",
					!hasImage && "border-dashed",
					options.isDragging && "border-primary ring-2 ring-primary",
				),
			),
			...background,
			...dropAttributes,
		],
		[
			...(hasImage
				? [previewOf(h, options)]
				: [
						isInteractive
							? pressable(
									h,
									{
										onClick: options.onPick,
										label: `Upload ${Str.toLowerCase(options.label)}`,
										className:
											"absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-lg px-3 font-prose hover:bg-surface-sunken active:bg-surface-sunken",
									},
									[
										icon(h, "UploadIcon", { className: "size-4 text-muted-foreground" }),
										typography(h, { size: "xs" }, [
											"Drop an image or ",
											typography(h, { size: "xs", weight: "medium", tone: "primary" }, [
												"browse",
											]),
										]),
										typography(h, { size: "2xs", tone: "muted" }, [options.formats]),
									],
								)
							: typography(h, { size: "xs", tone: "muted" }, ["None"]),
					]),
			...(options.isDragging
				? [
						hstack(
							h,
							{
								align: "center",
								justify: "center",
								className:
									"pointer-events-none absolute inset-0 bg-primary-a2 text-xs font-medium text-primary",
							},
							["Drop to upload"],
						),
					]
				: []),
		],
	)
	const caption = Option.match(hasImage ? hostOf(options.value) : Option.none(), {
		onNone: () => (hasImage ? "Uploaded image" : null),
		onSome: (host) => `Linked from ${host}`,
	})
	return vstack(h, { gap: "2", attributes: [h.Id(options.id)] }, [
		vstack(h, { gap: "0.5" }, [
			typography(h, { size: "sm", weight: "medium" }, [options.label]),
			typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [options.description]),
		]),
		box,
		...(isInteractive
			? [
					hstack(h, { gap: "2", align: "center", wrap: true }, [
						// An empty box is itself the upload target; a filled one needs Replace.
						...(options.value === ""
							? []
							: [
									button(
										h,
										{ variant: "outline", size: "sm", attributes: [h.OnClick(options.onPick)] },
										[icon(h, "UploadIcon", { className: "mr-1.5" }), "Replace"],
									),
									button(h, { variant: "ghost", size: "sm", attributes: [h.OnClick(options.onRemove)] }, [
										"Remove",
									]),
								]),
						textLink(h, { tone: "muted", onClick: options.onToggleLink, className: "ml-auto text-xs" }, [
							options.isLinkOpen ? "Hide link" : "Use a link",
						]),
					]),
				]
			: []),
		...(caption === null || options.isLinkOpen
			? []
			: [typography(h, { size: "xs", tone: "muted", truncate: true, className: "font-prose" }, [caption])]),
		...(options.isLinkOpen || options.error !== null
			? [
					input(h, {
						id: `${options.id}-link`,
						size: "sm",
						type: "url",
						isDisabled: options.isReadOnly,
						attributes: [
							h.AriaLabel(`${options.label} link`),
							h.Value(Option.isSome(hostOf(options.value)) || options.error !== null ? options.value : ""),
							h.Placeholder(options.linkPlaceholder),
							h.OnInput(options.onLinkInput),
						],
					}),
				]
			: []),
		...(options.error === null ? [] : [typography(h, { size: "xs", tone: "error" }, [options.error])]),
		fileInput(h, {
			id: imageSourceInputId(options.id),
			label: `Upload ${Str.toLowerCase(options.label)}`,
			accept: options.accept,
			onChange: options.onFiles,
		}),
	])
}
