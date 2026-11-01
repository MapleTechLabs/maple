import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../ui/copy-button"
import { eyebrow } from "../../ui/eyebrow"
import type { IconName } from "../../ui/icon"
import { Message, type Model } from "./model"

// `CopyScenarios`: every shape `CopyButton` is asked to take, side by side.

type H = HtmlBuilder<Message>

type CopyRow = Readonly<{
	id: string
	label: string
	value: string
	copyLabel: string
	tooltip?: boolean
	idleIcon?: IconName
	idleLabel?: string
	copiedLabel?: string
	variant?: "outline"
	size?: "icon-sm"
	isDisabled?: boolean
}>

const ROWS: ReadonlyArray<CopyRow> = [
	{ id: "default", label: "icon-xs / ghost (default)", value: "trace-abc123", copyLabel: "Trace ID" },
	{ id: "tooltip", label: "tooltip", value: "9f2c1a", copyLabel: "Commit SHA", tooltip: true },
	{ id: "link", label: "link glyph", value: "https://maple.dev", copyLabel: "Link", idleIcon: "LinkIcon", tooltip: true },
	{ id: "label", label: "with label / outline", value: "npm i @maple/cli", copyLabel: "Command", idleLabel: "Copy", variant: "outline" },
	{
		id: "long",
		label: "with label / long copied text",
		value: "https://maple.dev/share/xyz",
		copyLabel: "Link",
		idleLabel: "Copy link",
		copiedLabel: "Copied link",
		variant: "outline",
	},
	{ id: "icon-sm", label: "icon-sm / outline", value: "key_live_x", copyLabel: "API key", size: "icon-sm", variant: "outline" },
	// The throwing resolver: an empty copy is the error branch.
	{ id: "error", label: "error branch (10s hold)", value: "", copyLabel: "Broken value", tooltip: true },
	{ id: "hold", label: "10s hold (inspect the copied state)", value: "hold-me", copyLabel: "Held value", idleLabel: "Copy", variant: "outline" },
	{ id: "no-toast", label: "toast={false} (opt-out)", value: "issue_123", copyLabel: "Issue ID", idleLabel: "Copy", variant: "outline" },
	{ id: "disabled", label: "disabled", value: "x", copyLabel: "Nothing", isDisabled: true },
]

const cell = (h: H, label: string, node: Html): Html =>
	h.div(
		[h.Class("flex flex-col gap-1.5")],
		[
			eyebrow(h, { variant: "mono" }, [label]),
			h.div([h.Class("flex h-12 items-center rounded-md border bg-card px-3")], [node]),
		],
	)

const copyRow = (h: H, model: Model, row: CopyRow): Html => {
	const slot = `copy-${row.id}`
	return cell(
		h,
		row.label,
		CopyButton.view(h, {
			model: model.copies[slot] ?? CopyButton.init(),
			toParentMessage: (message) => Message.GotCopyMessage({ slot, message }),
			value: row.value,
			label: row.copyLabel,
			...(row.idleLabel === undefined ? undefined : { idleLabel: row.idleLabel }),
			...(row.copiedLabel === undefined ? undefined : { copiedLabel: row.copiedLabel }),
			...(row.idleIcon === undefined ? undefined : { idleIcon: row.idleIcon }),
			...(row.variant === undefined ? undefined : { variant: row.variant }),
			...(row.size === undefined ? undefined : { size: row.size }),
			...(row.tooltip === true ? { slot: "tooltip-trigger" } : undefined),
			attributes: [
				...(row.tooltip === true ? [h.DataAttribute("base-ui-tooltip-trigger", "")] : []),
				...(row.isDisabled === true ? [h.Disabled(true)] : []),
			],
		}),
	)
}

const copyableValue = (h: H, model: Model): Html => {
	const status = (model.copies["copy-inline"] ?? CopyButton.init()).status
	return cell(
		h,
		"CopyableValue (inline)",
		h.span(
			[h.Class("font-mono text-2xs")],
			[
				h.button(
					[
						h.Type("button"),
						h.AriaLabel("Copy span ID"),
						h.Class(
							status === "copied"
								? "-mx-0.5 cursor-pointer rounded-sm px-0.5 text-left transition-colors bg-severity-info-a3"
								: status === "error"
									? "-mx-0.5 cursor-pointer rounded-sm px-0.5 text-left transition-colors bg-severity-error-a3"
									: "-mx-0.5 cursor-pointer rounded-sm px-0.5 text-left hover:bg-surface-sunken active:bg-surface-sunken",
						),
						h.Title("Click to copy"),
						h.OnClick(
							Message.GotCopyMessage({
								slot: "copy-inline",
								message: CopyButton.Message.ClickedCopy({ text: "7f3c9a21b4e8" }),
							}),
						),
					],
					["7f3c9a21b4e8"],
				),
			],
		),
	)
}

export const copyScenarios = (h: H, model: Model): ReadonlyArray<Html> => [
	...ROWS.map((row) => copyRow(h, model, row)),
	copyableValue(h, model),
]
