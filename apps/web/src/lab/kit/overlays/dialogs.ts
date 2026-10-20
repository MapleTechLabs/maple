import { cn } from "@maple/ui/lib/utils"
import { inputControlChromeStyles, inputControlLayoutStyles, inputStyles } from "@maple/ui/styles/ui/input"
import { labelStyles } from "@maple/ui/styles/ui/label"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import type * as Dialog from "../../../ui/dialog"
import {
	dialogDescription,
	dialogFooter,
	dialogHeader,
	dialogPanel,
	dialogTitle,
	view as dialogView,
} from "../../../ui/dialog-view"
import { Message } from "./model"

// Dialog-like overlays, each open on mount.
type H = HtmlBuilder<Message>

const itemRow = (h: H, children: ReadonlyArray<Html>) =>
	h.div([h.Class("flex min-h-48 items-start")], children)

/** `<Label><Input defaultValue /></Label>`: an uncontrolled input inside its label. */
const labelledInput = (h: H, id: string, label: string, value: string): Html =>
	h.label(
		[h.Class(cn(labelStyles, "flex flex-col items-start gap-2")), h.DataAttribute("slot", "label")],
		[
			label,
			h.span(
				[
					h.Class(cn(inputControlLayoutStyles, inputControlChromeStyles)),
					h.DataAttribute("size", "default"),
					h.DataAttribute("slot", "input-control"),
				],
				[
					h.input([
						h.Class(cn(inputStyles)),
						h.DataAttribute("slot", "input"),
						h.Id(id),
						h.Value(value),
					]),
				],
			),
		],
	)

const closeButton = (
	h: H,
	close: ReadonlyArray<ChildAttribute>,
	slot: string,
	variant: "ghost" | "outline",
	text: string,
) => button(h, { variant, attributes: [h.DataAttribute("slot", slot), h.Tabindex(0), ...close] }, [text])

export const kitDialog = (h: H, model: Dialog.Model): Html =>
	h.submodel({
		slotId: "dialog",
		model,
		view: dialogView,
		viewInputs: {
			toView: ({ trigger, portal }) =>
				itemRow(h, [button(h, { variant: "outline", attributes: trigger }, ["Open dialog"]), portal]),
			toContent: (close) => [
				dialogHeader(h, "dialog", [
					dialogTitle(h, "dialog", model.id, "Rename dashboard"),
					dialogDescription(
						h,
						"dialog",
						model.id,
						"The new name shows in the sidebar for everyone in the org.",
					),
				]),
				dialogPanel(h, "dialog", model.id, [
					labelledInput(h, `${model.id}-name`, "Name", "Checkout latency"),
				]),
				dialogFooter(h, "dialog", [
					closeButton(h, close, "dialog-close", "ghost", "Cancel"),
					button(h, {}, ["Save"]),
				]),
			],
		},
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
	})

export const kitAlertDialog = (h: H, model: Dialog.Model): Html =>
	h.submodel({
		slotId: "alert-dialog",
		model,
		view: dialogView,
		viewInputs: {
			toView: ({ trigger, portal }) =>
				itemRow(h, [
					button(h, { variant: "destructive-outline", attributes: trigger }, ["Delete alert rule"]),
					portal,
				]),
			toContent: (close) => [
				dialogHeader(h, "alert-dialog", [
					dialogTitle(h, "alert-dialog", model.id, "Delete this alert rule?"),
					dialogDescription(
						h,
						"alert-dialog",
						model.id,
						"Checkout p95 latency stops evaluating and its open incidents are resolved.",
					),
				]),
				dialogFooter(h, "alert-dialog", [
					closeButton(h, close, "alert-dialog-cancel", "outline", "Cancel"),
					button(
						h,
						{
							variant: "destructive",
							attributes: [h.DataAttribute("slot", "alert-dialog-action")],
						},
						["Delete rule"],
					),
				]),
			],
		},
		toParentMessage: (message) => Message.GotAlertDialogMessage({ message }),
	})

export const kitSheet = (h: H, model: Dialog.Model): Html =>
	h.submodel({
		slotId: "sheet",
		model,
		view: dialogView,
		viewInputs: {
			side: "right",
			toView: ({ trigger, portal }) =>
				itemRow(h, [button(h, { variant: "outline", attributes: trigger }, ["Open sheet"]), portal]),
			toContent: () => [
				dialogHeader(h, "sheet", [
					dialogTitle(h, "sheet", model.id, "Span details"),
					dialogDescription(h, "sheet", model.id, "POST /api/checkout on checkout-svc"),
				]),
				dialogPanel(h, "sheet", model.id, [
					h.p([h.Class("text-sm")], ["Duration 412 ms, status Error, 14 child spans."]),
				]),
				dialogFooter(h, "sheet", [button(h, { variant: "outline" }, ["Open trace"])]),
			],
		},
		toParentMessage: (message) => Message.GotSheetMessage({ message }),
	})
