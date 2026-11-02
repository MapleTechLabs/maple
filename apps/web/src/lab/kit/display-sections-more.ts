import type { Html, HtmlBuilder } from "foldkit/html"
import type { CopyStatus } from "@maple/views/ui/copy-button"
import { delta } from "@maple/views/ui/delta"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { meter, segmentedBar } from "@maple/views/ui/meter"
import { miniBars } from "@maple/views/ui/mini-bars"
import { skeleton, skeletonList } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statFigure } from "@maple/views/ui/stat-figure"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { tableSkeleton } from "@maple/views/ui/table-skeleton"
import { typography } from "@maple/views/ui/typography"
import { ROWS } from "./display-sections"
import { kitRow, kitSection } from "./kit-layout"

// The second half of `/lab/kit/display`: values, loading states and tables.

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
const BARS = [3, 5, 4, 8, 6, 9, 12, 7, 5, 6, 10, 14, 11, 8, 6, 4]

export const keyValueSection = <M>(h: HtmlBuilder<M>, copyStatus: CopyStatus, onCopy: M): Html =>
	kitSection(h, "Key value", [
		keyValueList(h, { divided: true, className: "max-w-md" }, [
			keyValue(h, { label: "Service" }, ["checkout-svc"]),
			keyValue(h, { label: "Trace id", mono: true, copy: { status: copyStatus, onCopy } }, [TRACE_ID]),
			keyValue(h, { label: "Status" }, ["Error"]),
		]),
	])

export const meterSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Meter, segmented bar, mini bars", [
		h.div(
			[h.Class("flex max-w-md flex-col gap-3")],
			[
				meter(h, { value: 0.62, label: "Quota used" }),
				meter(h, { value: 0.91, tone: "crit", label: "Error budget" }),
				segmentedBar(h, {
					label: "Status mix",
					segments: [
						{ key: "ok", value: 82, className: "bg-severity-info" },
						{ key: "warn", value: 12, className: "bg-severity-warn" },
						{ key: "crit", value: 6, className: "bg-severity-error" },
					],
				}),
				miniBars(h, {
					values: BARS,
					label: "Requests per minute",
					className: "h-8 w-48 text-primary",
				}),
			],
		),
	])

export const statSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Stat figure and delta", [
		kitRow(h, undefined, [
			statFigure(h, { value: "412", unit: "req/s", size: "sm" }),
			statFigure(h, { value: "238", unit: "ms", size: "md", mono: true }),
			statFigure(h, { value: "99.82", unit: "%", size: "lg" }),
			delta(h, { ratio: 0.12 }),
			delta(h, { ratio: -0.08 }),
			delta(h, { ratio: 0.24, invert: true }),
			delta(h, { ratio: 0 }),
		]),
	])

export const skeletonSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Skeleton and table skeleton", [
		h.div(
			[h.Class("grid grid-cols-2 gap-6")],
			[
				h.div(
					[h.Class("flex flex-col gap-2")],
					[
						skeleton(h, "h-4 w-48"),
						skeleton(h, "h-4 w-32"),
						skeletonList(h, { rows: 3, label: "Loading services" }),
					],
				),
				tableSkeleton(h, { columns: 3, rows: 3 }),
			],
		),
	])

export const tableSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Table", [
		table(h, {}, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Service"]),
					tableHead(h, ["Req/s"], "text-right"),
					tableHead(h, ["Errors"], "text-right"),
					tableHead(h, ["p95"], "text-right"),
				]),
			]),
			tableBody(
				h,
				ROWS.map((row) =>
					tableRow(h, [
						tableCell(h, [row.service]),
						tableCell(h, [row.rps], "text-right"),
						tableCell(h, [row.errors], "text-right"),
						tableCell(h, [row.p95], "text-right"),
					]),
				),
			),
		]),
	])

/** `typography` on the type scale and tones, laid out with `hstack` and `vstack`. */
export const typeAndStackSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Typography and stacks", [
		vstack(h, { gap: "2", className: "max-w-md" }, [
			typography(h, { size: "sm", weight: "medium", tone: "foreground" }, ["checkout-api"]),
			typography(h, { size: "xs", tone: "muted" }, ["Meta: 1.2k requests in this window"]),
			typography(h, { size: "2xs", tone: "subtle", mono: true, numeric: true }, ["4bf92f35 · 12.4ms"]),
			typography(h, { size: "xs", tone: "error" }, ["Couldn't load the service map"]),
		]),
		hstack(h, { gap: "2", wrap: true }, [
			typography(h, { size: "xs", tone: "muted" }, ["Row"]),
			typography(h, { size: "xs", tone: "soft" }, ["gap 2"]),
			typography(h, { size: "xs", tone: "faint" }, ["wraps"]),
		]),
		hstack(h, { gap: "3", justify: "between", className: "max-w-md" }, [
			typography(h, { size: "sm", truncate: true }, ["A long label that truncates before the value"]),
			typography(h, { size: "sm", mono: true, numeric: true }, ["98.2%"]),
		]),
	])
