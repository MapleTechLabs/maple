import { StatusPageComponentStatus, UptimeMonitorId } from "@maple/domain"
import type { StatusPageDraftComponent, V2UptimeMonitor } from "@maple/domain/http/v2"
import { STATUS_PAGE_MAX_URL_LENGTH } from "@maple/domain/status-page"
import { Option, Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { bareUrl } from "../../alerts/shared/uptime-derive"
import { formIssues, nameFromUrl, wirePayload } from "../../alerts/uptime-form/derive"
import { emptyForm } from "../../alerts/uptime-form/form"

// "What's on it": the org's monitors as a checklist, components without a monitor, and a URL
// that becomes a new HTTP monitor. The builder and the editor's Add component share it.

/** Pages this small start with every monitor on them; past it the user picks. */
export const PRECHECK_MAX_MONITORS = 8

export const PickerRow = Schema.Struct({
	key: Schema.String,
	/** `null` for a component without a monitor, whose status is set by hand. */
	monitorId: Schema.NullOr(UptimeMonitorId),
	isChecked: Schema.Boolean,
	/** "Shown as": the name on the page, the monitor's own until renamed. */
	name: Schema.String,
	group: Schema.String,
	manualStatus: StatusPageComponentStatus,
})
export type PickerRow = typeof PickerRow.Type

export const Picker = Schema.Struct({
	rows: Schema.Array(PickerRow),
	nextKey: Schema.Number,
	isUrlOpen: Schema.Boolean,
	url: Schema.String,
	urlIssue: Schema.NullOr(Schema.String),
	isCreatingMonitor: Schema.Boolean,
	/** The row just added by hand: its name input takes focus as it mounts. */
	autofocusKey: Schema.NullOr(Schema.String),
})
export type Picker = typeof Picker.Type

export const emptyPicker: Picker = {
	rows: [],
	nextKey: 1,
	isUrlOpen: false,
	url: "",
	urlIssue: null,
	isCreatingMonitor: false,
	autofocusKey: null,
}

export const monitorKey = (id: UptimeMonitorId) => `m:${id}`

const monitorRow = (monitor: V2UptimeMonitor, isChecked: boolean): PickerRow => ({
	key: monitorKey(monitor.id),
	monitorId: monitor.id,
	isChecked,
	name: monitor.name,
	group: "",
	manualStatus: "operational",
})

/** One row per monitor; a small org starts with all but heartbeats checked. */
export const seedPicker = (monitors: ReadonlyArray<V2UptimeMonitor>, precheck: boolean): Picker => ({
	...emptyPicker,
	isUrlOpen: monitors.length === 0,
	rows: monitors.map((monitor) =>
		monitorRow(
			monitor,
			precheck && monitors.length <= PRECHECK_MAX_MONITORS && monitor.kind !== "heartbeat",
		),
	),
})

/** What a monitor checks: its URL, host and port, record, or "heartbeat". */
export const monitorTarget = (monitor: V2UptimeMonitor): string => {
	const config = monitor.config
	switch (config.type) {
		case "http":
			return bareUrl(config.url)
		case "tcp":
			return `${config.host}:${config.port}`
		case "dns":
			return `${config.record_type} ${config.hostname}`
		case "heartbeat":
			return "heartbeat"
	}
}

export const PickerMessage = defineMessageUnion({
	ToggledRow: { key: Schema.String },
	ChangedRowName: { key: Schema.String, value: Schema.String },
	ChangedRowGroup: { key: Schema.String, value: Schema.String },
	PickedRowStatus: { key: Schema.String, value: Schema.String },
	ClickedMoveRow: { key: Schema.String, offset: Schema.Number },
	ClickedRemoveRow: { key: Schema.String },
	ClickedAddManual: {},
	/** A key pressed on the Add button before the new row's input mounted and took focus. */
	PressedKeyOnAdd: { key: Schema.String },
	ClickedOpenUrl: {},
	ChangedUrl: { value: Schema.String },
	SubmittedUrl: {},
	ClickedCancelUrl: {},
})
export type PickerMessage = typeof PickerMessage.Type

const decodeStatus = Schema.decodeUnknownOption(StatusPageComponentStatus)

const mapRow = (picker: Picker, key: string, change: (row: PickerRow) => PickerRow): Picker => ({
	...picker,
	rows: picker.rows.map((row) => (row.key === key ? change(row) : row)),
})

/** Swaps the row with the next checked row in `offset`'s direction; unchecked rows stay put. */
export const moveRow = (picker: Picker, key: string, offset: number): Picker => {
	const from = picker.rows.findIndex((row) => row.key === key)
	const checked = picker.rows.flatMap((row, index) => (row.isChecked ? [index] : []))
	const at = checked.indexOf(from)
	const to = checked[at + (offset < 0 ? -1 : 1)]
	const row = picker.rows[from]
	const other = to === undefined ? undefined : picker.rows[to]
	if (at < 0 || to === undefined || row === undefined || other === undefined) return picker
	return {
		...picker,
		rows: picker.rows.map((entry, index) => (index === from ? other : index === to ? row : entry)),
	}
}

/** A `https://` URL for what was pasted: a bare host gets the scheme. */
export const normalizeUrl = (raw: string): string => {
	const trimmed = raw.trim()
	return trimmed === "" || /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** The uptime form's own check of an HTTP target, so the server's refusals read the same here. */
export const urlIssueOf = (url: string): string | null =>
	url === ""
		? "Paste the URL to check."
		: url.length > STATUS_PAGE_MAX_URL_LENGTH
			? `Keep it under ${STATUS_PAGE_MAX_URL_LENGTH} characters.`
			: (formIssues(emptyForm({ url, name: nameFromUrl(url) }))[0] ?? null)

/** The create payload of a new HTTP check with the uptime form's defaults. */
export const monitorPayloadFor = (url: string): Readonly<Record<string, unknown>> =>
	wirePayload(emptyForm({ url, name: nameFromUrl(url) }), false)

export type PickerStep = Readonly<{
	picker: Picker
	/** A URL to create a monitor for, once it passes the checks. */
	createMonitor: Option.Option<string>
}>

const step = (picker: Picker): PickerStep => ({ picker, createMonitor: Option.none() })

export const updatePicker = (picker: Picker, message: PickerMessage): PickerStep =>
	PickerMessage.match<PickerStep>(message, {
		// A component added another way leaves an old URL error behind; it no longer applies.
		ToggledRow: ({ key }) =>
			step({
				...mapRow(picker, key, (row) => ({ ...row, isChecked: !row.isChecked })),
				urlIssue: null,
			}),
		// Typing in the new row means its focus arrived: keys stop being routed from the button.
		ChangedRowName: ({ key, value }) =>
			step({
				...mapRow(picker, key, (row) => ({ ...row, name: value })),
				autofocusKey: picker.autofocusKey === key ? null : picker.autofocusKey,
			}),
		PressedKeyOnAdd: ({ key }) =>
			picker.autofocusKey === null || key.length !== 1
				? step(picker)
				: step(mapRow(picker, picker.autofocusKey, (row) => ({ ...row, name: row.name + key }))),
		ChangedRowGroup: ({ key, value }) => step(mapRow(picker, key, (row) => ({ ...row, group: value }))),
		PickedRowStatus: ({ key, value }) =>
			Option.match(decodeStatus(value), {
				onNone: () => step(picker),
				onSome: (manualStatus) => step(mapRow(picker, key, (row) => ({ ...row, manualStatus }))),
			}),
		ClickedMoveRow: ({ key, offset }) => step(moveRow(picker, key, offset)),
		ClickedRemoveRow: ({ key }) =>
			step({ ...picker, rows: picker.rows.filter((row) => row.key !== key || row.monitorId !== null) }),
		ClickedAddManual: () => {
			const key = `c:${picker.nextKey}`
			const row: PickerRow = {
				key,
				monitorId: null,
				isChecked: true,
				name: "",
				group: "",
				manualStatus: "operational",
			}
			return step({
				...picker,
				rows: [...picker.rows, row],
				nextKey: picker.nextKey + 1,
				autofocusKey: key,
				urlIssue: null,
			})
		},
		ClickedOpenUrl: () => step({ ...picker, isUrlOpen: true, urlIssue: null }),
		ChangedUrl: ({ value }) => step({ ...picker, url: value, urlIssue: null }),
		ClickedCancelUrl: () => step({ ...picker, isUrlOpen: false, url: "", urlIssue: null }),
		SubmittedUrl: () => {
			if (picker.isCreatingMonitor) return step(picker)
			const url = normalizeUrl(picker.url)
			const issue = urlIssueOf(url)
			return issue !== null
				? step({ ...picker, urlIssue: issue })
				: {
						...step({ ...picker, url, isCreatingMonitor: true, urlIssue: null }),
						createMonitor: Option.some(url),
					}
		},
	})

/** The new monitor joins the list checked, at the end, and the field clears for the next. */
export const monitorCreated = (picker: Picker, monitor: V2UptimeMonitor): Picker => ({
	...picker,
	isCreatingMonitor: false,
	url: "",
	urlIssue: null,
	rows: [...picker.rows.filter((row) => row.key !== monitorKey(monitor.id)), monitorRow(monitor, true)],
})

export const monitorFailed = (picker: Picker, message: string): Picker => ({
	...picker,
	isCreatingMonitor: false,
	urlIssue: message,
})

/** Rows the page lists, in order. */
export const checkedRows = (picker: Picker): ReadonlyArray<PickerRow> =>
	picker.rows.filter((row) => row.isChecked)

export const rowIssue = (row: PickerRow): string | null =>
	row.isChecked && row.name.trim() === "" ? "Name this component" : null

export const hasRowIssues = (picker: Picker): boolean => picker.rows.some((row) => rowIssue(row) !== null)

const orNull = (value: string): string | null => (value.trim() === "" ? null : value.trim())

/**
 * The page's components as the create and the preview take them, in list order. A row with no
 * name yet is left out: the API refuses a blank name, and `rowIssue` blocks the create meanwhile.
 */
export const draftComponents = (picker: Picker): ReadonlyArray<StatusPageDraftComponent> =>
	checkedRows(picker)
		.filter((row) => row.name.trim() !== "")
		.map((row) => ({
			name: row.name.trim(),
			group: orNull(row.group),
			monitor_id: row.monitorId,
			manual_status: row.monitorId === null ? row.manualStatus : null,
			show_uptime: true,
		}))
