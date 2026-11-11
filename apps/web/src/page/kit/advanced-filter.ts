import { Array as Arr } from "effect"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "@maple/views/ui/alert"
import type * as Dialog from "@maple/views/ui/dialog"
import { formDialog } from "@maple/views/ui/form-dialog"
import { button } from "@maple/views/ui/button"
import { kbd } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { panel } from "@maple/views/ui/panel"
import { hstack } from "@maple/views/ui/stack"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { typographyClass } from "@maple/views/ui/typography"

// The pieces around a list page's advanced filter dialog (`/traces`, `/logs`).

/** The Advanced filter header button with its `F` hint, tinted while a clause is applied. */
export const advancedFilterButton = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ isActive: boolean; onClick: M; attributes?: ReadonlyArray<Attribute<M>> }>,
): Html =>
	button(
		h,
		{
			variant: options.isActive ? "secondary" : "outline",
			size: "sm",
			className: "gap-2",
			attributes: [...(options.attributes ?? []), h.OnClick(options.onClick)],
		},
		[
			icon(h, "FilterIcon", { className: options.isActive ? "text-primary" : "text-muted-foreground" }),
			h.span([], ["Advanced filter"]),
			kbd(h, undefined, ["F"]),
		],
	)

/** The applied clause above the list, with its clear button. */
export const appliedWhereClause = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ whereClause: string; onClear: M }>,
): Html =>
	panel(h, { tone: "muted", className: "mb-4 flex-row items-center justify-between gap-2 px-3 py-2" }, [
		hstack(h, { gap: "2", shrink: true }, [
			icon(h, "FilterIcon", { className: "size-3.5 shrink-0 text-primary" }),
			truncatedText(h, {
				text: options.whereClause,
				mono: true,
				className: typographyClass({ size: "xs", tone: "foreground" }),
			}),
		]),
		iconButton(
			h,
			{
				label: "Clear filter",
				size: "icon-xs",
				className: typographyClass({ tone: "muted", hoverTone: "foreground", className: "shrink-0" }),
				attributes: [h.OnClick(options.onClear)],
			},
			[icon(h, "XmarkIcon")],
		),
	])

/** The where editor's box in the dialog: mono, resizable, a few lines tall. */
export const ADVANCED_TEXTAREA_CLASS = "font-mono text-sm leading-relaxed resize-y min-h-[200px] max-h-[40vh]"

/** The Advanced filter dialog: the page's editor and warnings, Apply and Clear. */
export const advancedFilterDialog = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		slotId: string
		dialog: Dialog.Model
		toDialogMessage: (message: Dialog.Message) => M
		description: ReadonlyArray<Html | string>
		onSubmit: M
		onClear: M
		editor: Html
		warnings: ReadonlyArray<string>
	}>,
): Html =>
	formDialog(h, {
		slotId: options.slotId,
		model: options.dialog,
		toParentMessage: options.toDialogMessage,
		title: "Advanced filter",
		description: options.description,
		className: "sm:max-w-3xl",
		panelClassName: "space-y-0",
		onSubmit: options.onSubmit,
		submitLabel: "Apply filter",
		footerStart: button(h, { variant: "ghost", attributes: [h.OnClick(options.onClear)] }, [
			"Clear filter",
		]),
		fields: [options.editor, ...whereClauseWarnings(h, options.warnings)],
	})

/** The clauses the parser dropped, under the editor. */
export const whereClauseWarnings = <M>(
	h: HtmlBuilder<M>,
	warnings: ReadonlyArray<string>,
): ReadonlyArray<Html> =>
	warnings.length === 0
		? []
		: [
				alert(h, { variant: "warn", size: "sm", className: "mt-2" }, [
					icon(h, "CircleWarningIcon", { size: 14 }),
					alertDescription(
						h,
						[
							h.ul(
								[h.Class("space-y-1")],
								Arr.map(warnings, (warning) => h.li([], [warning])),
							),
						],
						"text-severity-warn",
					),
				]),
			]
