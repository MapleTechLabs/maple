import type { Html, HtmlBuilder } from "foldkit/html"
import { type BubbleVariant, bubble, bubbleContent, bubbleGroup } from "../../ui/bubble"
import type { CopyStatus } from "../../ui/copy-button"
import { message, messageAvatar, messageContent, messageGroup, messageHeader } from "../../ui/message"
import { middleTruncate } from "../../ui/middle-truncate"
import { settingRow } from "../../ui/setting-row"
import { icon } from "../../ui/icon"
import { trace, traceDescription, traceIcon, traceLine, traceTitle } from "../../ui/trace"
import { truncatedId } from "../../ui/truncated-id"
import { truncatedText } from "../../ui/truncated-text"
import { avatarFallback } from "../../ui/display"
import { scrollArea } from "../../ui/scroll-area"
import { switchControl } from "../../ui/switch"
import { kitRow, kitSection } from "./kit-layout"

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
const LONG_URL =
	"https://api.maple.dev/v1/organizations/org_2f9a/dashboards/checkout-latency/widgets/p95-by-route"
const BUBBLE_VARIANTS: ReadonlyArray<BubbleVariant> = [
	"default",
	"secondary",
	"muted",
	"tinted",
	"outline",
	"ghost",
	"destructive",
]
const SCROLL_ROWS = Array.from(
	{ length: 12 },
	(_, index) => `span-${String(index + 1).padStart(2, "0")} GET /api/cart`,
)

/** The chat transcript's user bubble shape (page/investigations/conversation/kit/view-transcript.ts). */
const USER_BUBBLE = "rounded-lg px-3.5 py-2.5 font-prose text-sm"

const assistantMessage = <M>(h: HtmlBuilder<M>): Html =>
	message(h, {}, [
		messageAvatar(h, [avatarFallback(h, { className: "size-6" }, "M")]),
		messageContent(h, [
			messageHeader(h, ["Maple"]),
			bubbleGroup(h, [
				bubble(h, { variant: "ghost" }, [
					bubbleContent(
						h,
						["payment-svc errors rose to 4.2% after the 11:40 deploy."],
						"font-prose text-sm",
					),
				]),
			]),
		]),
	])

const userMessage = <M>(h: HtmlBuilder<M>): Html =>
	message(h, { align: "end" }, [
		messageContent(h, [
			bubble(h, { variant: "secondary", align: "end" }, [
				bubbleContent(h, ["Which route is failing?"], USER_BUBBLE),
			]),
		]),
	])

export const conversationSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Message and bubble", [
		messageGroup(h, [assistantMessage(h), userMessage(h)], "max-w-xl"),
		kitRow(
			h,
			undefined,
			BUBBLE_VARIANTS.map((variant) =>
				bubble(h, { variant }, [bubbleContent(h, [variant], "rounded-lg")]),
			),
		),
	])

export const traceSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Trace", [
		trace(
			h,
			[
				traceLine(h, {}, [
					traceIcon(h, [icon(h, "CheckIcon")]),
					traceTitle(h, ["Searched traces"]),
					traceDescription(h, ["service.name = payment-svc"]),
				]),
				traceLine(h, { status: "error" }, [
					traceIcon(h, [icon(h, "MagnifierIcon")]),
					traceTitle(h, ["Read logs"]),
					traceDescription(h, ["query timed out"]),
				]),
				traceLine(h, { status: "pending" }, [traceIcon(h, []), traceTitle(h, ["Group by route"])]),
			],
			"max-w-md",
		),
	])

export const truncationSection = <M>(
	h: HtmlBuilder<M>,
	copy: { readonly copyStatus: CopyStatus; readonly onCopy: (value: string) => M },
): Html =>
	kitSection(h, "Truncation", [
		h.div(
			[h.Class("flex max-w-sm flex-col gap-2 text-sm")],
			[
				truncatedId(h, { value: TRACE_ID, kind: "trace" }),
				truncatedId(h, {
					value: TRACE_ID,
					kind: "trace",
					ellipsis: true,
					copy: { status: copy.copyStatus, onClick: copy.onCopy(TRACE_ID) },
				}),
				truncatedText(h, { text: LONG_URL, mono: true }),
				middleTruncate(h, { text: LONG_URL, tail: 18, mono: true }),
			],
		),
	])

// Base UI `useId` values, kept verbatim (S1: ids are part of the DOM).
const baseUiId = (n: string) => `base-ui-_r_${n}_`

export const settingRowSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Setting row", [
		h.div(
			[h.Class("flex max-w-xl flex-col gap-3")],
			[
				settingRow(h, {
					ids: { control: baseUiId("0"), label: baseUiId("1"), description: baseUiId("2") },
					label: "Weekly digest",
					description: "A summary of incidents every Monday.",
					filled: true,
					control: switchControl(h, {
						id: baseUiId("3"),
						inputId: baseUiId("0"),
						labelledBy: baseUiId("1"),
						describedBy: baseUiId("2"),
						isChecked: true,
						isFilled: true,
					}),
				}),
				settingRow(h, {
					ids: { control: baseUiId("6"), label: baseUiId("7"), description: baseUiId("8") },
					label: "Framed, active",
					description: "Framed setting row.",
					framed: true,
					active: true,
					control: switchControl(h, {
						id: baseUiId("9"),
						inputId: baseUiId("6"),
						labelledBy: baseUiId("7"),
						describedBy: baseUiId("8"),
						isChecked: false,
					}),
				}),
				settingRow(h, {
					ids: { control: baseUiId("c"), label: baseUiId("d"), description: baseUiId("f") },
					label: "Disabled",
					disabled: true,
					control: switchControl(h, {
						id: baseUiId("e"),
						inputId: baseUiId("c"),
						labelledBy: baseUiId("d"),
						isChecked: false,
						isDisabled: true,
					}),
				}),
			],
		),
	])

export const scrollAreaSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Scroll area", [
		scrollArea(
			h,
			{
				idPrefix: baseUiId("h"),
				className: "h-40 max-w-md rounded-md border",
				overflowY: { endPx: 146, thumbHeightPx: 77.96052631578948 },
			},
			[
				h.div(
					[h.Class("flex flex-col p-2 font-mono text-xs")],
					SCROLL_ROWS.map((row) => h.span([h.Class("py-1")], [row])),
				),
			],
		),
	])
