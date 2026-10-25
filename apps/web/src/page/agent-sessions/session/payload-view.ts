import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { prettyJson } from "../../../lib/display-text"
import * as ToggleGroup from "../../../ui/toggle-group"
import { Message } from "./message"

// Payload views: JSON payloads, message bodies, the view switch and disclosure.

type H = HtmlBuilder<Message>

/** A payload pretty-printed where it parses as a JSON object or array, verbatim otherwise. */
export const jsonPayload = (text: string): Readonly<{ formatted: string; isJson: boolean }> =>
	Option.match(prettyJson(text), {
		onNone: () => ({ formatted: text, isJson: false }),
		onSome: (formatted) => ({ formatted, isJson: true }),
	})

/** A message body's reading: markdown for prose, pretty-printed JSON for a JSON document. */
export const messageBody = (text: string): Readonly<{ rendered: "md" | "json"; formatted: string }> => {
	const payload = jsonPayload(text)
	return { rendered: payload.isJson ? "json" : "md", formatted: payload.formatted }
}

/** Presence in `openRows` means "flipped away from the default". */
export const disclosed = (openRows: ReadonlyArray<string>, key: string, byDefault: boolean): boolean =>
	openRows.includes(key) ? !byDefault : byDefault

const SEGMENT_CLASS = "font-mono text-3xs uppercase tracking-[0.08em] sm:text-3xs"

/** `ViewSwitch`: the rendered and raw segments; clicking the pressed one keeps the view. */
export const viewSwitch = (
	h: H,
	options: Readonly<{ rendered: string; isRaw: boolean; rawKey: string; className?: string }>,
): Html =>
	ToggleGroup.view(h, {
		model: ToggleGroup.init({ label: "Body view", values: [options.isRaw ? "raw" : "rendered"] }),
		toParentMessage: (message) =>
			Message.PressedBodyView({
				key: options.rawKey,
				isRaw: message._tag === "ClickedItem" ? message.value === "raw" : options.isRaw,
			}),
		items: [
			{ value: "rendered", label: options.rendered },
			{ value: "raw", label: "raw" },
		],
		variant: "outline",
		size: "xs",
		itemClassName: SEGMENT_CLASS,
		className: cn("shrink-0 self-center", options.className),
	})
