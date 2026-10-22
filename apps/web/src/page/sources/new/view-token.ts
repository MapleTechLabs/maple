import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { linkButton } from "../../../ui/button"
import { copyableField } from "../../../ui/copyable-field"
import { panel } from "../../../ui/panel"
import { spinner } from "../../../ui/spinner"
import { statusDot } from "../../../ui/status-dot"
import * as Setup from "../kit/setup"
import { sourceHref } from "../kit/shared"
import { Message } from "./message"
import type { Created, Model } from "./model"
import { isReceiving } from "./update"

// `TokenStep` and `FirstDataStatus`: step 3.

type H = HtmlBuilder<Message>

const firstDataStatus = (h: H, model: Model, created: Created): Html => {
	const receiving = isReceiving(model)
	return panel(h, { className: "flex-row items-center gap-3 px-4 py-3" }, [
		receiving ? statusDot(h, { tone: "ok", size: "lg" }) : spinner(h, "size-3.5"),
		h.span(
			[h.Class("grow text-sm font-medium")],
			[receiving ? "Receiving data" : "Waiting for first data"],
		),
		linkButton(
			h,
			{ variant: receiving ? "default" : "outline", size: "sm", href: sourceHref(created.source) },
			[receiving ? "Open source" : "Skip for now"],
		),
	])
}

export const tokenStep = (h: H, model: Model, created: Created): Html =>
	h.div(
		[h.Class("flex w-full max-w-3xl flex-col gap-4")],
		[
			alert(h, { variant: "ok" }, [
				alertTitle(h, ["Source created. Copy the token now, it won't be shown again."]),
				alertDescription(h, ["Use it as the ingest key wherever this source sends from."], "text-xs"),
			]),
			panel(h, { padded: true, className: "gap-2" }, [
				h.span([h.Class("text-sm font-medium")], ["Token"]),
				copyableField(h, {
					id: "source-token",
					value: created.secret,
					copyLabel: "Source token",
					copy: model.tokenCopy,
					toCopyMessage: (message) => Message.GotTokenCopyMessage({ message }),
				}),
			]),
			Setup.view(h, {
				model: model.setup,
				toParentMessage: (message) => Message.GotSetupMessage({ message }),
				platform: created.source.platform,
				name: created.source.name,
				token: created.secret,
				keyPrefix: created.source.key_prefix,
				idPrefix: "source-setup",
			}),
			firstDataStatus(h, model, created),
		],
	)
