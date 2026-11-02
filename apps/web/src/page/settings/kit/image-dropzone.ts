import { cn } from "@maple/ui/lib/utils"
import { Effect, Option } from "effect"
import { File } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { fileInput } from "../../../ui/file-input"
import { icon } from "../../../ui/icon"
import { input } from "../../../ui/input"
import { label } from "../../../ui/label"

// `ImageDropzone` and `TypeToConfirmField`. The parent owns `isDragging` and checks the picked
// file with `checkImage`.

const MAX_BYTES = 10 * 1024 * 1024
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif"
const DEFAULT_HINT = "Drop an image or click to upload. PNG, JPG, WEBP or GIF, up to 10 MB."

/** The toast a rejected file gets, or none when it is an image within the size cap. */
export const checkImage = (file: File.File): Option.Option<string> =>
	!File.mimeType(file).startsWith("image/")
		? Option.some("Please choose an image file")
		: File.size(file) > MAX_BYTES
			? Option.some(`Image must be ${Math.round(MAX_BYTES / (1024 * 1024))} MB or smaller`)
			: Option.none()

/** `fileInputRef.current?.click()`: opens the hidden input's picker. */
export const clickFileInput = (inputId: string) =>
	Effect.sync(() => {
		document.getElementById(inputId)?.click()
	})

export type ImageDropzoneOptions<M> = Readonly<{
	inputId: string
	preview: Html
	isUploading: boolean
	isDragging: boolean
	isReadOnly?: boolean
	targetLabel: string
	changeLabel: string
	/** `null` hides the hint; `undefined` shows the default one. */
	hint?: string | null
	/** Row layout: the title and hint beside the target, the actions on the right. */
	title?: string
	onPick: M
	onFiles: (files: ReadonlyArray<File.File>) => M
	onDragOver: M
	onDragLeave: M
	onRemove?: M
}>

export const imageDropzone = <M>(h: HtmlBuilder<M>, options: ImageDropzoneOptions<M>): Html => {
	const isReadOnly = options.isReadOnly ?? false
	const isInteractive = !options.isUploading && !isReadOnly
	const hint = options.hint === undefined ? DEFAULT_HINT : options.hint
	const actions = h.div(
		[h.Class("flex shrink-0 items-center gap-2")],
		[
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					isLoading: options.isUploading,
					attributes: [h.OnClick(options.onPick)],
				},
				[icon(h, "UploadIcon", { className: "mr-1.5" }), options.changeLabel],
			),
			...(options.onRemove === undefined
				? []
				: [
						button(
							h,
							{
								variant: "ghost",
								size: "sm",
								isDisabled: !isInteractive,
								attributes: [h.OnClick(options.onRemove)],
							},
							["Remove"],
						),
					]),
		],
	)
	const hintLine = hint === null ? [] : [h.p([h.Class("font-prose text-xs text-muted-foreground")], [hint])]
	return h.div(
		[h.Class("flex items-center gap-4")],
		[
			h.div(
				[
					...(isReadOnly
						? []
						: [
								h.AriaDisabled(!isInteractive),
								h.AriaLabel(options.targetLabel),
								h.Role("button"),
							]),
					h.Class(
						cn(
							"relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-dashed p-1 outline-none transition-colors",
							isReadOnly
								? null
								: isInteractive
									? "cursor-pointer hover:border-primary active:border-primary focus-visible:ring-2 focus-visible:ring-ring"
									: "cursor-not-allowed opacity-60",
							// The dashed outline is a drop cue: shown on hover, focus and drag, not at rest.
							options.isDragging ? "border-primary ring-2 ring-primary" : "border-transparent",
						),
					),
					h.Tabindex(isInteractive ? 0 : -1),
					...(isInteractive
						? [
								h.OnClick(options.onPick),
								h.OnKeyDownPreventDefault((key) =>
									key === "Enter" || key === " "
										? Option.some(options.onPick)
										: Option.none(),
								),
								h.OnDragOver(options.onDragOver),
								h.OnDragLeave(options.onDragLeave),
								h.AllowDrop(),
								h.OnDropFiles(options.onFiles),
							]
						: []),
				],
				[
					options.preview,
					...(options.isDragging
						? [
								h.div(
									[
										h.Class(
											"absolute inset-0 flex items-center justify-center rounded-md bg-primary-a2 text-center text-3xs font-medium text-primary",
										),
									],
									["Drop image"],
								),
							]
						: []),
				],
			),
			...(options.title === undefined
				? [h.div([h.Class("space-y-1.5")], [...(isReadOnly ? [] : [actions]), ...hintLine])]
				: [
						h.div(
							[h.Class("min-w-0 flex-1 space-y-1")],
							[
								h.div([h.Class("text-sm font-medium text-foreground")], [options.title]),
								...hintLine,
							],
						),
						...(isReadOnly ? [] : [actions]),
					]),
			fileInput(h, {
				id: options.inputId,
				label: options.targetLabel,
				accept: ACCEPT,
				onChange: options.onFiles,
			}),
		],
	)
}

/** `TypeToConfirmField`: "Type X to confirm." over its input. */
export const typeToConfirmField = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ id: string; expected: string; value: string; onInput: (value: string) => M }>,
): Html =>
	h.div(
		[h.Class("space-y-2")],
		[
			label(h, { className: "text-xs", attributes: [h.For(options.id)] }, [
				"Type ",
				h.span([h.Class("font-mono font-semibold")], [options.expected]),
				" to confirm.",
			]),
			input(h, {
				id: options.id,
				attributes: [
					h.Value(options.value),
					h.OnInput(options.onInput),
					h.Placeholder(options.expected),
					h.Autocomplete("off"),
				],
			}),
		],
	)
