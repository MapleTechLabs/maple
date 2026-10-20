import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../../ui/copy-button"
import { type ClampedRendering, type ClampLines, clampedText } from "./clamped-text"
import { Message } from "./message"
import type { Model } from "./model"
import { disclosed, messageBody } from "./payload-view"
import { textHash } from "./transcript-rows"

// The transcript's wiring of `ClampedText`, `MessageBody` and `CopyButton` to the page's Model.

type H = HtmlBuilder<Message>

/** A clamped body whose expansion, measured overflow and markdown parse live in the Model under `textKey`. */
export const clampedBody = (
	h: H,
	model: Model,
	options: Readonly<{
		text: string
		textKey: string
		rendering?: ClampedRendering
		isMono?: boolean
		clampLines?: ClampLines
		toneClass?: string
		proseClassName?: string
	}>,
): Html =>
	clampedText(h, {
		text: options.text,
		rendering: options.rendering,
		isMono: options.isMono,
		clampLines: options.clampLines,
		toneClass: options.toneClass,
		proseClassName: options.proseClassName,
		isExpanded: disclosed(model.openRows, options.textKey, false),
		onToggleExpanded: Message.ToggledRow({ key: options.textKey }),
		markdown: (shown) => model.markdown[textHash(shown)]?.document ?? null,
		isMeasuredClamped: model.clampedBodies.includes(options.textKey),
		onMeasured: (isClamped) => Message.MeasuredClamp({ key: options.textKey, isClamped }),
		codeActions: {
			onCopy: (code) => Message.ClickedCodeAction({ action: "copy", code, language: "" }),
			onDownload: (code, language) => Message.ClickedCodeAction({ action: "download", code, language }),
			copiedCode: model.codeCopy.code,
		},
	})

/** `MessageBody`: the chosen reading of a captured message, clamped. */
export const messageBodyView = (
	h: H,
	model: Model,
	options: Readonly<{ text: string; rowKey: string; clampLines?: ClampLines; proseClassName?: string }>,
): Html => {
	const body = messageBody(options.text)
	const isRaw = disclosed(model.openRows, `${options.rowKey}:raw`, false)
	return clampedBody(h, model, {
		text: isRaw ? options.text : body.formatted,
		textKey: `${options.rowKey}:text`,
		rendering: isRaw ? "text" : body.rendered,
		isMono: !isRaw && body.rendered === "json",
		clampLines: options.clampLines,
		proseClassName: options.proseClassName,
	})
}

/** `<CopyButton value label>`: the transcript's copies share one status, keyed by what was copied. */
export const payloadCopyButton = (
	h: H,
	model: Model,
	options: Readonly<{
		key: string
		value: string
		label: string
		className?: string
		/** `tooltip` (the transcript's); the span popover's copies have none. */
		hasTooltip?: boolean
		idleLabel?: string
		iconSize?: number
		variant?: "outline" | "ghost"
		size?: "sm" | "icon-xs"
	}>,
): Html =>
	CopyButton.view(h, {
		model: model.payloadCopy.key === options.key ? model.payloadCopy.copy : CopyButton.init(),
		toParentMessage: (message) => Message.GotPayloadCopyMessage({ key: options.key, message }),
		value: options.value,
		label: options.label,
		className: cn(options.className),
		idleLabel: options.idleLabel,
		iconSize: options.iconSize,
		variant: options.variant,
		size: options.size,
		// TODO(tooltip): the copy's tooltip is drawn as its trigger.
		slot: options.hasTooltip === false ? undefined : "tooltip-trigger",
		attributes: options.hasTooltip === false ? [] : [h.DataAttribute("base-ui-tooltip-trigger", "")],
	})
