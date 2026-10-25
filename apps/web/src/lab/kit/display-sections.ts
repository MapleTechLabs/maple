import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "../../ui/alert"
import { button } from "../../ui/button"
import { card, cardDescription, cardFooter, cardHeader, cardPanel, cardTitle } from "../../ui/card"
import { delta } from "../../ui/delta"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyMessage, emptyTitle } from "../../ui/empty"
import {
	item,
	itemActions,
	itemContent,
	itemDescription,
	itemGroup,
	itemMedia,
	itemTitle,
} from "../../ui/item"
import { listRow } from "../../ui/list-row"
import { panel, panelBody, panelHeader } from "../../ui/panel"
import { statFigure } from "../../ui/stat-figure"
import { icon } from "../../ui/icon"
import { badge } from "../../ui/display"
import { kitSection } from "./kit-layout"

// The first half of `/lab/kit/display`: surfaces, alerts, empty states and rows.

export const ALERT_VARIANTS = ["default", "info", "ok", "warn", "crit", "done"] as const
export const ROWS = [
	{ service: "checkout-svc", rps: "412", errors: "1.8%", p95: "238 ms" },
	{ service: "payment-svc", rps: "188", errors: "4.2%", p95: "612 ms" },
	{ service: "inventory-svc", rps: "96", errors: "0.1%", p95: "41 ms" },
]

const ingestCard = <M>(h: HtmlBuilder<M>): Html =>
	card(h, [
		cardHeader(h, [
			cardTitle(h, ["Ingest volume"]),
			cardDescription(h, ["Spans received in the current billing cycle."]),
		]),
		cardPanel(h, [statFigure(h, { value: "12.4M", unit: "spans", size: "lg" })]),
		cardFooter(h, [button(h, { variant: "outline", size: "sm" }, ["View usage"])]),
	])

const servicesPanel = <M>(h: HtmlBuilder<M>): Html =>
	panel(h, {}, [
		panelHeader(h, {
			title: "Top services",
			scope: badge(h, { variant: "meta" }, ["production"]),
			action: button(h, { variant: "ghost", size: "xs" }, ["All"]),
		}),
		panelBody(
			h,
			ROWS.map((row) =>
				listRow(h, {
					divided: true,
					title: row.service,
					meta: `${row.rps} req/s`,
					trailing: delta(h, { ratio: 0.12 }),
				}),
			),
		),
	])

export const cardAndPanelSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Card and panel", [
		h.div([h.Class("grid grid-cols-2 gap-6")], [ingestCard(h), servicesPanel(h)]),
	])

export const alertSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Alert", [
		h.div(
			[h.Class("grid grid-cols-2 gap-3")],
			[
				...ALERT_VARIANTS.map((variant) =>
					alert(h, { variant }, [
						icon(h, "CircleInfoIcon"),
						alertTitle(h, ["Alert ", variant]),
						alertDescription(h, ["The ingest key was rotated 3 days ago."]),
					]),
				),
				alert(h, { size: "sm", variant: "warn" }, [
					icon(h, "CircleInfoIcon"),
					alertDescription(h, ["Small alert, one line."]),
				]),
			],
		),
	])

export const emptySection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Empty", [
		h.div(
			[h.Class("grid grid-cols-2 gap-6")],
			[
				empty(h, [
					emptyHeader(h, [
						emptyMedia(h, { variant: "icon" }, [icon(h, "DatabaseIcon")]),
						emptyTitle(h, ["No traces yet"]),
						emptyDescription(h, ["Send spans from any OpenTelemetry SDK to see them here."]),
					]),
				]),
				emptyMessage(h, { dashed: true }, ["No dashboards match this filter."]),
			],
		),
	])

export const itemSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Item and list row", [
		itemGroup(
			h,
			[
				item(h, { variant: "outline" }, [
					itemMedia(h, { variant: "icon" }, [icon(h, "ServerIcon")]),
					itemContent(h, [
						itemTitle(h, ["api-gateway"]),
						itemDescription(h, ["3 instances, us-east-1"]),
					]),
					itemActions(h, [button(h, { variant: "outline", size: "sm" }, ["Open"])]),
				]),
				item(h, { variant: "muted", size: "sm" }, [
					itemContent(h, [itemTitle(h, ["Muted item, small"])]),
				]),
			],
			"max-w-xl",
		),
		h.div(
			[h.Class("max-w-xl rounded-md border")],
			[
				listRow(h, {
					divided: true,
					selected: true,
					title: "payment-svc",
					meta: "selected",
					trailing: "612 ms",
				}),
				listRow(h, {
					divided: true,
					density: "compact",
					title: "inventory-svc",
					meta: "compact",
					trailing: "41 ms",
				}),
			],
		),
	])
