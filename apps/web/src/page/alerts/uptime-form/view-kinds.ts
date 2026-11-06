import type { Html } from "foldkit/html"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { EveryUnit, GraceUnit, RecordType, ScheduleMode } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { type H, nameSection, section, selectField, textField } from "./view-fields"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"
import { destinationPicker } from "../../kit/destination-picker"

// The TCP, DNS and heartbeat sections, and the Service and Notify sections every kind shares.

const isRecordType = (value: string): value is typeof RecordType.Type =>
	Arr.some(RecordType.literals, (type) => type === value)
const isUnit = (value: string): value is typeof EveryUnit.Type =>
	Arr.some(EveryUnit.literals, (unit) => unit === value)
const isGraceUnit = (value: string): value is typeof GraceUnit.Type =>
	Arr.some(GraceUnit.literals, (unit) => unit === value)
const isMode = (value: string): value is typeof ScheduleMode.Type =>
	Arr.some(ScheduleMode.literals, (mode) => mode === value)

export const tcpSection = (h: H, model: Model): ReadonlyArray<Html> => [
	section(h, "Host and port", undefined, [
		hstack(h, { gap: "2", align: "start" }, [
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
		]),
	]),
	nameSection(h, model, "Defaults to host:port"),
]

export const dnsSection = (h: H, model: Model): ReadonlyArray<Html> => [
	section(h, "Record", undefined, [
		hstack(h, { gap: "2", align: "start" }, [
			selectField(h, {
				id: "uptime-record-type",
				label: "Record type",
				isLabelHidden: true,
				value: model.form.recordType,
				entries: Arr.map(RecordType.literals, (type) => ({ value: type, label: type })),
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
		]),
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
				? hstack(h, { gap: "2", align: "start" }, [
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
							entries: Arr.map(EveryUnit.literals, (unit) => ({ value: unit, label: unit })),
							onChange: (value) =>
								Message.ChangedEveryUnit({ unit: isUnit(value) ? value : "hours" }),
							className: "w-32",
						}),
					])
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
								entries: Arr.map(zones, (zone) => ({ value: zone, label: zone })),
								onChange: (value) => Message.ChangedText({ field: "cronTimezone", value }),
								className: "w-52",
							}),
						],
					),
		]),
		section(h, "Grace period", "how late a ping may be", [
			hstack(h, { gap: "2", align: "start" }, [
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
					entries: Arr.map(GraceUnit.literals, (unit) => ({ value: unit, label: unit })),
					onChange: (value) =>
						Message.ChangedGraceUnit({ unit: isGraceUnit(value) ? value : "minutes" }),
					className: "w-32",
				}),
			]),
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
				...Arr.map(names, (name) => ({ value: name, label: name })),
			],
			onChange: (value) => Message.ChangedText({ field: "serviceName", value }),
			className: "max-w-xs",
		}),
	])
}

/** Who hears about it: the chosen destinations and a menu of the rest. */
export const notifySection = (h: H, model: Model): Html =>
	section(h, "Notify", undefined, [
		destinationPicker(h, {
			rows: model.destinations,
			selectedIds: model.form.destinationIds,
			menu: model.destinationMenu,
			toMenuMessage: (message) => Message.GotDestinationMenuMessage({ message }),
			onRemove: (id) => Message.RemovedDestination({ id }),
			emptyText: "Nobody yet. The incident still opens in the inbox.",
		}),
	])
