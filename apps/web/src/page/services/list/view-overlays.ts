import { formatPercent } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { AsyncData } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import * as HoverCard from "../../../ui/hover-card"
import * as Tooltip from "../../../ui/tooltip"
import { commitDetailBody } from "../../kit/commit-card"
import { deployInfo, isResolvableSha } from "./derive"
import { Message, type RowTooltip } from "./message"
import type { Model, ServiceRow } from "./model"
import { overlayTriggerId } from "./update-overlays"

// The row tooltips (rollout split, sampling estimate, `UnnamedServiceHint`) and `CommitShaHoverCard`.

type H = HtmlBuilder<Message>

/** Trigger attributes for one row's overlays, by kind and row id. */
export type Overlays = Readonly<{
	tooltip: (kind: RowTooltip, rowId: string) => ReadonlyArray<ChildAttribute>
	commit: (rowId: string, sha: string) => ReadonlyArray<ChildAttribute>
}>

/** The row id the trigger ids hang off: desktop rows plain, mobile rows prefixed. */
export const rowIdOf = (service: ServiceRow, isMobile = false): string =>
	`${isMobile ? "m-" : ""}${service.serviceName}-${service.serviceNamespace}-${service.environment}`

/** `isUnnamedService`: the SDK's `unknown_service[:runtime]` default, or no name at all. */
export const isUnnamedService = (serviceName: string): boolean =>
	serviceName === "" || serviceName.startsWith("unknown_service")

type Entry = Readonly<{ id: string; service: ServiceRow }>

const entriesOf = (services: ReadonlyArray<ServiceRow>) => {
	const rows = services.flatMap((service) => [
		{ rowId: rowIdOf(service), service, isMobile: false },
		{ rowId: rowIdOf(service, true), service, isMobile: true },
	])
	const of = (
		kind: RowTooltip,
		keep: (service: ServiceRow, isMobile: boolean) => boolean,
	): ReadonlyArray<Entry> =>
		rows
			.filter((row) => keep(row.service, row.isMobile))
			.map((row) => ({ id: overlayTriggerId(kind, row.rowId), service: row.service }))
	const info = (service: ServiceRow) => deployInfo(service.commits)
	return {
		rollout: of(
			"rollout",
			(s, m) => !m && info(s)?.rollout !== undefined && info(s)?.errorsSince !== true,
		),
		sampling: of("sampling", (s, m) => !m && s.hasSampling),
		unnamed: of("unnamed", (s) => isUnnamedService(s.serviceName)),
		commit: rows.flatMap((row) => {
			const sha = info(row.service)?.sha ?? ""
			return !row.isMobile && isResolvableSha(sha)
				? [{ id: overlayTriggerId("commit", row.rowId, sha), sha, service: row.service }]
				: []
		}),
	}
}

const rolloutContent = (h: H, service: ServiceRow): ReadonlyArray<Html> => [
	h.div(
		[h.Class("flex flex-col gap-1")],
		(deployInfo(service.commits)?.rollout?.others ?? []).map((commit) =>
			h.div(
				[
					h.Key(commit.commitSha),
					h.Class("flex items-center justify-between gap-3 font-mono text-xs"),
				],
				[
					h.span([], [shortId(commit.commitSha, "sha")]),
					h.span([h.Class("tabular-nums text-muted-foreground")], [`${commit.percentage}%`]),
				],
			),
		),
	),
]

// JSX text runs are kept apart: a run boundary changes how the line is shaped.
const samplingContent = (h: H, service: ServiceRow): ReadonlyArray<Html> => [
	h.p(
		[],
		[
			"Estimated from ",
			formatPercent(1 / service.samplingWeight),
			" sampled traces (x",
			service.samplingWeight.toFixed(0),
			" extrapolation)",
		],
	),
]

const UNNAMED_CONTENT = (h: H): ReadonlyArray<Html | string> => [
	"This SDK never set ",
	h.code([h.Class("font-mono")], ["service.name"]),
	", so OpenTelemetry fell back to its default. Set ",
	h.code([h.Class("font-mono")], ["OTEL_SERVICE_NAME"]),
	" (or",
	" ",
	h.code([h.Class("font-mono")], ["serviceName"]),
	" in your SDK config) and the service will appear under its real name.",
]

/** `UnnamedServiceHint`: the warn badge that triggers the tooltip. */
export const unnamedServiceHint = (h: H, trigger: ReadonlyArray<ChildAttribute>): Html =>
	badge(h, { variant: "warn", size: "sm", className: "shrink-0 font-normal", attributes: trigger }, [
		"no service.name",
	])

const contentOf = (
	entries: ReadonlyArray<Entry>,
	triggerId: string,
	render: (service: ServiceRow) => ReadonlyArray<Html | string>,
) => {
	const found = entries.find((entry) => entry.id === triggerId)
	return found === undefined ? [] : render(found.service)
}

const tooltipLayer = (
	h: H,
	model: Model,
	kind: RowTooltip,
	entries: ReadonlyArray<Entry>,
	render: (service: ServiceRow) => ReadonlyArray<Html | string>,
	className: string,
	inner: (
		trigger: (id: string) => ReadonlyArray<ChildAttribute>,
		portals: ReadonlyArray<Html | null>,
	) => Html,
	portals: ReadonlyArray<Html | null>,
): Html =>
	h.submodel({
		slotId: `services-${kind}-tooltip`,
		model:
			kind === "rollout"
				? model.rolloutTooltip
				: kind === "sampling"
					? model.samplingTooltip
					: model.unnamedTooltip,
		view: Tooltip.view,
		toParentMessage: (message) => Message.GotRowTooltipMessage({ tooltip: kind, message }),
		viewInputs: {
			triggerIds: entries.map((entry) => entry.id),
			toContent: (triggerId) => contentOf(entries, triggerId, render),
			className,
			toView: ({ trigger, portal }) => inner((id) => trigger(id), [...portals, portal]),
		},
	})

/**
 * Wraps the table in its overlays: each Submodel hands its trigger attributes down and its
 * portal is placed after the table.
 */
export const withOverlays = (
	h: H,
	model: Model,
	clock: Readonly<{ nowMs: number; timeZone: string }>,
	services: ReadonlyArray<ServiceRow>,
	inner: (overlays: Overlays) => ReadonlyArray<Html>,
	toView: (children: ReadonlyArray<Html>) => Html,
): Html => {
	const entries = entriesOf(services)
	const triggerOf = (kind: RowTooltip, rowId: string) => overlayTriggerId(kind, rowId)
	return tooltipLayer(
		h,
		model,
		"rollout",
		entries.rollout,
		(s) => rolloutContent(h, s),
		"p-2",
		(rollout, p1) =>
			tooltipLayer(
				h,
				model,
				"sampling",
				entries.sampling,
				(s) => samplingContent(h, s),
				"",
				(sampling, p2) =>
					tooltipLayer(
						h,
						model,
						"unnamed",
						entries.unnamed,
						() => UNNAMED_CONTENT(h),
						"max-w-xs",
						(unnamed, p3) =>
							h.submodel({
								slotId: "services-commit-card",
								model: model.commitCard,
								view: HoverCard.view,
								toParentMessage: (message) => Message.GotCommitCardMessage({ message }),
								viewInputs: {
									triggerIds: entries.commit.map((entry) => entry.id),
									className: "w-80 p-0",
									toContent: (triggerId) => {
										const sha = triggerId.slice(-40)
										const owner = entries.commit.find((entry) => entry.id === triggerId)
										return [
											commitDetailBody(
												h,
												model.commitDetails[sha] ?? AsyncData.Loading(),
												clock,
												(copied) =>
													Message.ClickedCopyCommitSha({
														sha: copied,
														serviceName: owner?.service.serviceName ?? "",
														environment: owner?.service.environment ?? "",
													}),
											),
										]
									},
									toView: ({ triggerFor, portal }) => {
										const byKind = { rollout, sampling, unnamed }
										const overlays: Overlays = {
											tooltip: (kind, rowId) => byKind[kind](triggerOf(kind, rowId)),
											commit: (rowId, sha) =>
												triggerFor(overlayTriggerId("commit", rowId, sha)),
										}
										return toView([
											...inner(overlays),
											...[...p3, portal].filter(
												(portal): portal is Html => portal !== null,
											),
										])
									},
								},
							}),
						p2,
					),
				p1,
			),
		[],
	)
}
