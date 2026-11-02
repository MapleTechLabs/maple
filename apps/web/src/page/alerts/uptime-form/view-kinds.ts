import type { Html } from "foldkit/html"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import * as MenuView from "../../../ui/menu-view"
import { panel } from "../../../ui/panel"
import { pressable } from "../../../ui/pressable"
import { segmentedSelect } from "../../../ui/segmented-select"
import { EveryUnit, GraceUnit, RecordType, ScheduleMode } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { type H, nameSection, section, selectField, textField } from "./view-fields"

// The TCP, DNS and heartbeat sections, and the Service and Notify sections every kind shares.

const isRecordType = (value: string): value is typeof RecordType.Type =>
	RecordType.literals.some((type) => type === value)
const isUnit = (value: string): value is typeof EveryUnit.Type =>
	EveryUnit.literals.some((unit) => unit === value)
const isGraceUnit = (value: string): value is typeof GraceUnit.Type =>
	GraceUnit.literals.some((unit) => unit === value)
const isMode = (value: string): value is typeof ScheduleMode.Type =>
	ScheduleMode.literals.some((mode) => mode === value)

export const tcpSection = (h: H, model: Model): ReadonlyArray<Html> => [
	section(h, "Host and port", undefined, [
		h.div(
			[h.Class("flex items-start gap-2")],
			[
				textField(h, {
					field: "host",
					label: "Host",
					value: model.form.host,
					placeholder: "db.example.com",
					className: "min-w-0 flex-1",
					isLabelHidden: true,
				}),
				textField(h, {
					field: "port",
					label: "Port",
					value: model.form.port,
					placeholder: "5432",
					inputMode: "numeric",
					className: "w-24 shrink-0",
					isLabelHidden: true,
				}),
			],
		),
	]),
	nameSection(h, model, "Defaults to host:port"),
]

export const dnsSection = (h: H, model: Model): ReadonlyArray<Html> => [
	section(h, "Record", undefined, [
		h.div(
			[h.Class("flex items-start gap-2")],
			[
				selectField(h, {
					id: "uptime-record-type",
					label: "Record type",
					isLabelHidden: true,
					value: model.form.recordType,
					entries: RecordType.literals.map((type) => ({ value: type, label: type })),
					onChange: (value) =>
						Message.ChangedRecordType({ recordType: isRecordType(value) ? value : "A" }),
					className: "w-24 shrink-0",
				}),
				textField(h, {
					field: "hostname",
					label: "Hostname",
					value: model.form.hostname,
					placeholder: "example.com",
					className: "min-w-0 flex-1",
					isLabelHidden: true,
				}),
			],
		),
		textField(h, {
			field: "expected",
			label: "Expected value (optional)",
			value: model.form.expected,
			placeholder: "Any answer passes when empty",
		}),
	]),
	nameSection(h, model, "Defaults to the record"),
]

export const heartbeatSection = (h: H, model: Model): ReadonlyArray<Html> => {
	const form = model.form
	const zones = model.timeZones.includes(form.cronTimezone)
		? model.timeZones
		: [form.cronTimezone, ...model.timeZones]
	return [
		nameSection(h, model, "nightly-billing-export"),
		section(h, "Expect a ping", undefined, [
			segmentedSelect(h, {
				ariaLabel: "Schedule",
				size: "sm",
				className: "w-fit",
				value: form.scheduleMode,
				onChange: (value) =>
					Message.ChangedScheduleMode({ mode: isMode(value) ? value : "interval" }),
				options: [
					{ value: "interval", label: "Every…" },
					{ value: "cron", label: "Cron expression" },
				],
			}),
			form.scheduleMode === "interval"
				? h.div(
						[h.Class("flex items-start gap-2")],
						[
							textField(h, {
								field: "everyValue",
								label: "Every",
								value: form.everyValue,
								inputMode: "numeric",
								className: "w-24",
								isLabelHidden: true,
							}),
							selectField(h, {
								id: "uptime-every-unit",
								label: "Unit",
								isLabelHidden: true,
								value: form.everyUnit,
								entries: EveryUnit.literals.map((unit) => ({ value: unit, label: unit })),
								onChange: (value) =>
									Message.ChangedEveryUnit({ unit: isUnit(value) ? value : "hours" }),
								className: "w-32",
							}),
						],
					)
				: h.div(
						[h.Class("flex flex-wrap items-start gap-2")],
						[
							textField(h, {
								field: "cronExpression",
								label: "Cron expression",
								value: form.cronExpression,
								placeholder: "0 2 * * *",
								className: "min-w-40 flex-1",
								isLabelHidden: true,
							}),
							selectField(h, {
								id: "uptime-cron-timezone",
								label: "Time zone",
								isLabelHidden: true,
								value: form.cronTimezone,
								entries: zones.map((zone) => ({ value: zone, label: zone })),
								onChange: (value) => Message.ChangedText({ field: "cronTimezone", value }),
								className: "w-52",
							}),
						],
					),
		]),
		section(h, "Grace period", "how late a ping may be", [
			h.div(
				[h.Class("flex items-start gap-2")],
				[
					textField(h, {
						field: "graceValue",
						label: "Grace period",
						value: form.graceValue,
						inputMode: "numeric",
						className: "w-24",
						isLabelHidden: true,
					}),
					selectField(h, {
						id: "uptime-grace-unit",
						label: "Grace unit",
						isLabelHidden: true,
						value: form.graceUnit,
						entries: GraceUnit.literals.map((unit) => ({ value: unit, label: unit })),
						onChange: (value) =>
							Message.ChangedGraceUnit({ unit: isGraceUnit(value) ? value : "minutes" }),
						className: "w-32",
					}),
				],
			),
		]),
	]
}

/** Optional service, from the services traced in the last day. */
export const serviceSection = (h: H, model: Model): Html => {
	const current = model.form.serviceName
	const names =
		current === "" || model.services.includes(current) ? model.services : [current, ...model.services]
	return section(h, "Service", "optional", [
		selectField(h, {
			id: "uptime-service",
			label: "Service",
			isLabelHidden: true,
			value: current,
			entries: [
				{ value: "", label: "No service" },
				...names.map((name) => ({ value: name, label: name })),
			],
			onChange: (value) => Message.ChangedText({ field: "serviceName", value }),
			className: "max-w-xs",
		}),
	])
}

/** Who hears about it: the chosen destinations and a menu of the rest. */
export const notifySection = (h: H, model: Model): Html => {
	const rows = model.destinations ?? []
	// `null` until destinations sync: a neutral name, not "unavailable", for the saved ones.
	const fallback = model.destinations === null ? "Destination" : "Unavailable destination"
	const selected = model.form.destinationIds.map((id) => ({
		id,
		name: rows.find((row) => row.id === id)?.name ?? fallback,
	}))
	const available = rows.filter((row) => !model.form.destinationIds.some((id) => id === row.id))
	return section(h, "Notify", undefined, [
		panel(h, { className: "divide-y shadow-none" }, [
			...selected.map((destination) =>
				h.div(
					[h.Key(destination.id), h.Class("flex items-center gap-2 px-3 py-2")],
					[
						icon(h, "BellIcon", { className: "text-muted-foreground" }),
						h.span([h.Class("min-w-0 flex-1 truncate text-sm")], [destination.name]),
						iconButton(
							h,
							{
								label: `Stop notifying ${destination.name}`,
								className: "text-muted-foreground",
								attributes: [h.OnClick(Message.RemovedDestination({ id: destination.id }))],
							},
							[icon(h, "XmarkIcon")],
						),
					],
				),
			),
			...(selected.length === 0
				? [
						h.p(
							[h.Class("px-3 py-2.5 text-sm text-muted-foreground")],
							["Nobody yet. The incident still opens in the inbox."],
						),
					]
				: []),
			...(available.length === 0
				? []
				: [
						h.submodel({
							slotId: model.destinationMenu.id,
							model: model.destinationMenu,
							view: MenuView.view,
							viewInputs: {
								entries: available.map((row): MenuView.MenuEntry => ({
									_tag: "Item",
									value: row.id,
									label: row.name,
								})),
								align: "start",
								className: "w-72",
								toView: ({ trigger, withTrigger }) =>
									h.span(
										[h.Class("contents")],
										withTrigger(
											pressable(
												h,
												{
													className:
														"flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-surface-sunken active:bg-surface-sunken hover:text-foreground active:text-foreground",
													attributes: trigger,
												},
												[icon(h, "PlusIcon", { size: 14 }), "Add destination"],
											),
										),
									),
							},
							toParentMessage: (message) => Message.GotDestinationMenuMessage({ message }),
						}),
					]),
		]),
	])
}
