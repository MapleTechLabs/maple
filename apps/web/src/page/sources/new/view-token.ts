import { isPublicSourcePlatform, isPushSourcePlatform } from "@maple/domain/primitives"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { copyableField } from "@maple/views/ui/copyable-field"
import { icon } from "@maple/views/ui/icon"
import { type CheckRow, flowColumns, liveChecklist, savedBanner, stepCard } from "../../kit/connect-flow"
import * as Setup from "../kit/setup"
import { sourceHref } from "../kit/shared"
import { Message } from "./message"
import type { Created, FlowHost, Model } from "./model"
import { isReceiving } from "./update"
import { flowFooter } from "./view-footer"
import { showsUpRail } from "./view-push-rail"
import { typography } from "@maple/views/ui/typography"
import { vstack } from "@maple/views/ui/stack"

// `TokenStep`: the Send data step. The one-time token, the setup snippet, then the first-data poll.

type H = HtmlBuilder<Message>

/** `last_used_at` is set by the first accepted request, so one poll answers both rows. */
const firstDataRows = (created: Created, receiving: boolean): ReadonlyArray<CheckRow> => {
	const prefix = created.source.key_prefix ?? "the token"
	return receiving
		? [
				{ state: "done", title: "Token works", detail: `${prefix} accepted by ingest` },
				{ state: "done", title: "First data received", detail: "The source page shows what arrived" },
			]
		: [
				{
					state: "working",
					title: "Token works",
					detail: `Waiting for the first request signed with ${prefix}`,
				},
				{
					state: "waiting",
					title: "First data received",
					detail: "Checked every 5 seconds. You can leave; the source keeps listening.",
				},
			]
}

/** The drawer stays in onboarding: Done closes it, and the source keeps listening without it. */
const drawerFooter = (h: H, receiving: boolean): Html =>
	flowFooter(h, {
		back: null,
		hint: receiving ? "Data is arriving." : "Saved. Safe to close; the source keeps listening.",
		host: "drawer",
		actions: [
			button(
				h,
				{
					variant: receiving ? "default" : "outline",
					attributes: [h.OnClick(Message.ClickedDone())],
				},
				["Done"],
			),
		],
	})

const footer = (h: H, created: Created, receiving: boolean, host: FlowHost): Html =>
	host === "drawer"
		? drawerFooter(h, receiving)
		: flowFooter(h, {
				host: "page",
				back: null,
				hint: receiving
					? "Data is arriving. The source page shows what came in."
					: "Saved. Open source unlocks with the first data.",
				actions: receiving
					? [
							linkButton(h, { href: sourceHref(created.source) }, [
								"Open source",
								icon(h, "ArrowRightIcon", { size: 14 }),
							]),
						]
					: [
							linkButton(h, { variant: "outline", href: sourceHref(created.source) }, [
								"Skip for now",
							]),
							button(h, { isDisabled: true }, [
								"Open source",
								icon(h, "ArrowRightIcon", { size: 14 }),
							]),
						],
			})

export const tokenStep = (h: H, model: Model, created: Created, host: FlowHost): Html => {
	const receiving = isReceiving(model)
	const platform = created.source.platform
	return vstack(h, { gap: "4", grow: true, className: "w-full" }, [
		flowColumns(
			h,
			[
				savedBanner(h, "Saved as a source. Safe to leave."),
				stepCard(
					h,
					{
						icon: "KeyIcon",
						title: isPublicSourcePlatform(platform) ? "Copy the public token" : "Copy the token",
						note: "Shown once",
					},
					[
						typography(h, { size: "xs", tone: "muted", as: "p" }, [
							isPublicSourcePlatform(platform)
								? "Copy it now, it won't be shown again. It is a public token, safe to ship in your browser code."
								: "Copy it now, it won't be shown again. Use it as the ingest key wherever this source sends from.",
						]),
						copyableField(h, {
							id: "source-token",
							value: created.secret,
							copyLabel: "Source token",
							copy: model.tokenCopy,
							toCopyMessage: (message) => Message.GotTokenCopyMessage({ message }),
						}),
					],
				),
				stepCard(h, { icon: "CodeIcon", title: `Send data from ${created.source.name}` }, [
					Setup.view(h, {
						model: model.setup,
						toParentMessage: (message) => Message.GotSetupMessage({ message }),
						platform,
						name: created.source.name,
						token: created.secret,
						keyPrefix: created.source.key_prefix,
						idPrefix: "source-setup",
					}),
				]),
				liveChecklist(h, {
					title: receiving ? "Receiving data" : "Waiting for first data",
					rows: firstDataRows(created, receiving),
				}),
			],
			isPushSourcePlatform(platform) ? showsUpRail(h, platform) : null,
		),
		footer(h, created, receiving, host),
	])
}
