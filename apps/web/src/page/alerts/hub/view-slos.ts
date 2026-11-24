import { SLO_BURN_WINDOWS_MINUTES, windowLabel } from "@maple/domain/slo"
import { pluralize } from "@maple/ui/lib/format"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { skeleton } from "@maple/views/ui/skeleton"
import { vstack } from "@maple/views/ui/stack"
import {
	numericTableCell,
	ROW_LINK_LIFT,
	rowLink,
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
} from "@maple/views/ui/table"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { listToolbar, toolbarStat } from "../../kit/list-toolbar"
import { newSloHref, sloHref } from "../shared/slo-commands"
import {
	budgetLeft,
	budgetToneOf,
	burnTone,
	fastestBurn,
	formatBurn,
	formatSli,
	formatTarget,
	formatWindow,
	hasNoData,
	isBurning,
	isSpent,
	NO_DATA_HINT,
	scopeLine,
	sliLabel,
	sliTone,
} from "../shared/slo-derive"
import { alertingState, budgetBar, toneText } from "../shared/slo-view"
import { Message } from "./message"
import { type Model, type SloListRow } from "./model"
import { gatedLinkButton } from "../../kit/gated-controls"

type H = HtmlBuilder<Message>

const slosEmptyState = (h: H, model: Model, serviceName: string | undefined): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "GaugeIcon", { size: 18 })]),
				emptyTitle(h, ["No SLOs yet"]),
				emptyDescription(h, [
					"An SLO sets the share of a service's requests that must succeed or stay fast, and alerts when the error budget burns too fast.",
				]),
			]),
			emptyActions(h, [
				gatedLinkButton(
					h,
					model,
					"alerts:manage",
					{ size: "sm", href: newSloHref({ serviceName }) },
					[icon(h, "PlusIcon"), "New SLO"],
				),
			]),
		],
		"py-12",
	)

const readout = (h: H, model: Model, rows: ReadonlyArray<SloListRow>): ReadonlyArray<Html> => {
	// Every SLO's status arrives in one read; none at all means that read failed, not that nothing burns.
	if (rows.length > 0 && Arr.every(rows, (row) => row.status === null)) {
		return [
			toolbarStat(h, { value: String(rows.length), label: pluralize(rows.length, "SLO") }),
			toolbarStat(h, {
				value: "–",
				label: "figures unavailable",
				dot: "warn",
				attributes: [h.Title("Couldn't read the SLOs' current figures. Reload to try again.")],
			}),
		]
	}
	const burning = Arr.filter(rows, (row) => isBurning(row, model.incidents ?? []))
	const spent = Arr.filter(rows, (row) => row.status !== null && isSpent(row.slo, row.status))
	const silent = Arr.filter(rows, (row) => row.status !== null && hasNoData(row.status))
	return [
		toolbarStat(h, { value: String(rows.length), label: pluralize(rows.length, "SLO") }),
		toolbarStat(h, {
			value: String(burning.length),
			label: "burning",
			dot: burning.length > 0 ? "crit" : undefined,
			attributes:
				burning.length === 0
					? []
					: [
							h.Title(
								Arr.join(
									Arr.map(burning, (row) => row.slo.name),
									", ",
								),
							),
						],
		}),
		toolbarStat(h, {
			value: String(spent.length),
			label: "out of budget",
			dot: spent.length > 0 ? "warn" : undefined,
		}),
		// Only when there is one: an SLO that counts nothing is a filter to fix, not a state to watch.
		...(silent.length === 0
			? []
			: [
					toolbarStat(h, {
						value: String(silent.length),
						label: "without data",
						attributes: [h.Title(NO_DATA_HINT)],
					}),
				]),
	]
}

/** "5m, 30m, 1h, 2h, 6h, 24h": every window a tier reads. */
const BURN_WINDOWS = Arr.join(Arr.map(SLO_BURN_WINDOWS_MINUTES, windowLabel), ", ")

const dash = (h: H): Html => typography(h, { size: "xs", tone: "faint" }, ["–"])

const sloRow = (h: H, model: Model, row: SloListRow): Html => {
	const { slo, status } = row
	// A window that counted nothing has no SLI, no budget and no burn to read.
	const figures = status === null || hasNoData(status) ? null : status
	const burn = figures === null ? null : fastestBurn(figures)
	return tableRow(
		h,
		[
			tableCell(h, [
				vstack(h, { gap: "0.5", shrink: true }, [
					rowLink(
						h,
						{
							href: sloHref(slo.id),
							className: typographyClass({ size: "sm", weight: "medium", truncate: true }),
						},
						[slo.name],
					),
					typography(h, { size: "xs", tone: "muted", mono: true, truncate: true }, [
						scopeLine(slo),
					]),
				]),
			]),
			tableCell(h, [
				vstack(h, { gap: "0.5" }, [
					typography(h, { size: "sm" }, [sliLabel(slo.sli)]),
					typography(h, { size: "xs", tone: "muted" }, [
						`${formatTarget(slo)} over ${formatWindow(slo.window_days)}`,
					]),
				]),
			]),
			numericTableCell(h, [
				figures === null
					? dash(h)
					: typography(
							h,
							{ size: "xs", numeric: true, tone: toneText(sliTone(slo, figures.sli)) },
							[formatSli(figures.sli)],
						),
			]),
			// Lifted over the row's link, so the hint beside "No data" can be hovered.
			tableCell(h, [
				status === null
					? dash(h)
					: budgetBar(h, budgetLeft(status), {
							className: ROW_LINK_LIFT,
							tone: budgetToneOf(slo, status),
						}),
			]),
			numericTableCell(h, [
				burn === null
					? dash(h)
					: typography(h, { size: "xs", numeric: true, tone: toneText(burnTone(slo, burn)) }, [
							formatBurn(burn),
						]),
			]),
			tableCell(h, [alertingState(h, slo, model.incidents ?? [])]),
		],
		undefined,
		[h.Key(slo.id)],
	)
}

const slosTable = (h: H, model: Model, rows: ReadonlyArray<SloListRow>): Html =>
	table(h, { variant: "card", ariaLabel: "SLOs", className: "min-w-[760px]" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["SLO"]),
				tableHead(h, ["Indicator"]),
				tableHead(h, ["Current SLI"], "text-right"),
				tableHead(h, ["Budget left"]),
				tableHead(h, ["Fastest burn"], "text-right", [
					h.Title(`The fastest burn rate of the ${BURN_WINDOWS} windows`),
				]),
				tableHead(h, ["Alerting"]),
			]),
		]),
		tableBody(
			h,
			Arr.map(rows, (row) => sloRow(h, model, row)),
		),
	])

export const slosTab = (h: H, model: Model): Html => {
	const data = model.slos.data
	if (AsyncData.isFailure(data))
		return errorState(h, {
			failure: data.error,
			title: "Couldn't load SLOs",
			onRetry: Message.ClickedRetrySlos(),
			className: "py-12",
		})
	return Option.match(AsyncData.getData(data), {
		onNone: () => vstack(h, { gap: "4" }, [skeleton(h, "h-9 w-2/3"), skeleton(h, "h-64 w-full")]),
		onSome: (rows) =>
			rows.length === 0
				? slosEmptyState(h, model, model.search.serviceName)
				: vstack(h, { gap: "4" }, [
						listToolbar(h, { className: "pb-0", trailing: readout(h, model, rows) }),
						slosTable(h, model, rows),
					]),
	})
}
