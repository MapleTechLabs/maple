import { describe, expect, test } from "vitest"
import * as Chart from "../../charts/chart"
import * as Workload from "../../page/infra-integrations/gcp/workload/model"
import * as TimeRangePicker from "../../page/kit/time-range-picker"
import { Message, type Model } from "./model"
import { init, update } from "./update"

const start = () => init({ timeZone: "UTC" }).model

const page = (model: Model, message: Workload.Message) =>
	update(model, Message.GotWorkloadMessage({ message }))

const ready = (model: Model): Model => page(model, Workload.Message.CompletedLoadChartRuntime()).model

describe("Google Cloud workload lab", () => {
	test("opens on the Cloud Run service with its series in place and nothing to fetch", () => {
		const opened = init({ timeZone: "UTC" })
		expect(opened.model.workload.service).toBe("cloudRun")
		expect(opened.model.workload.window).not.toBeNull()
		expect(opened.model.workload.timeseries.data._tag).toBe("Success")
		expect(opened.commands?.length).toBe(1)
	})

	test("switching pages mounts the other workload fresh, keeping the loaded chart runtime", () => {
		const hovered = page(
			ready(start()),
			Workload.Message.GotChartMessage({ chartId: "gcp-chart-0", message: Chart.Message.LeftLegend() }),
		).model
		expect(Object.keys(hovered.workload.charts)).toEqual(["gcp-chart-0"])
		const sql = update(hovered, Message.ClickedLabPage({ page: "sql" })).model
		expect([sql.workload.service, sql.workload.name]).toEqual(["cloudSql", "acme-prod:orders-db"])
		expect([sql.workload.charts, sql.workload.chartRuntime._tag]).toEqual([{}, "Ready"])
		expect(update(sql, Message.ClickedLabPage({ page: "nope" })).model).toEqual(sql)
	})

	test("Reload spins without a request, and a stale spin end leaves the newer spin running", () => {
		const first = page(start(), Workload.Message.ClickedReload())
		expect(first.model.workload.isReloading).toBe(true)
		const second = page(first.model, Workload.Message.ClickedReload()).model
		const stale = page(second, Workload.Message.CompletedReloadSpin({ version: 1 })).model
		expect(stale.workload.isReloading).toBe(true)
		const done = page(stale, Workload.Message.CompletedReloadSpin({ version: 2 })).model
		expect(done.workload.isReloading).toBe(false)
	})

	test("the time picker takes input, but a picked preset leaves the fixture window", () => {
		const before = start()
		const typed = page(
			before,
			Workload.Message.GotTimePickerMessage({
				message: TimeRangePicker.Message.ChangedShorthand({ value: "3h" }),
			}),
		).model
		expect(typed.workload.timePicker).not.toEqual(before.workload.timePicker)
		const picked = page(
			typed,
			Workload.Message.GotTimePickerMessage({
				message: TimeRangePicker.Message.ClickedPreset({ value: "1h" }),
			}),
		).model
		expect([picked.workload.window, picked.workload.search]).toEqual([before.workload.window, {}])
	})
})
