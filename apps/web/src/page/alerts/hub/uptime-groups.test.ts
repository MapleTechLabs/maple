import { describe, expect, test } from "vitest"
import { downMonitor, httpMonitor, monitorId } from "../shared/uptime-test-monitors"
import { groupMonitors, NO_NAMESPACE, serviceNamespaces } from "./uptime-groups"

const row = (serviceName: string, serviceNamespace: string, spanCount: number) => ({
	serviceName,
	serviceNamespace,
	spanCount,
})

describe("service namespaces", () => {
	test("a service takes the namespace it sent the most spans under, summed across environments", () => {
		expect(
			serviceNamespaces([
				row("api", "shop", 400),
				row("api", "billing", 300),
				row("api", "billing", 300),
				row("worker", "", 10),
			]),
		).toEqual({ api: "billing", worker: "" })
	})

	test("Maple's own check service is not a namespace source", () => {
		expect(serviceNamespaces([row("maple-uptime", "maple-services", 900)])).toEqual({})
	})
})

describe("monitor groups", () => {
	const shop = httpMonitor({ id: monitorId(1), name: "shop", service_name: "checkout-api" })
	const billing = downMonitor({ service_name: "payments-api" })
	const unlinked = httpMonitor({ id: monitorId(4), name: "cron", service_name: null })
	const unseen = httpMonitor({ id: monitorId(5), name: "legacy", service_name: "retired-api" })
	const namespaces = { "checkout-api": "shop", "payments-api": "billing" }

	test("named groups run A to Z, with unlinked and unseen services under No namespace last", () => {
		expect(
			groupMonitors([unlinked, shop, unseen, billing], namespaces).map(([namespace, monitors]) => [
				namespace,
				monitors.map((monitor) => monitor.name),
			]),
		).toEqual([
			["billing", ["payments-api"]],
			["shop", ["shop"]],
			[NO_NAMESPACE, ["cron", "legacy"]],
		])
	})

	test("a service named like an object built-in groups under No namespace", () => {
		const builtIn = httpMonitor({ id: monitorId(6), name: "ctor", service_name: "constructor" })
		expect(groupMonitors([builtIn, shop], namespaces).map(([namespace]) => namespace)).toEqual([
			"shop",
			NO_NAMESPACE,
		])
	})

	test("without any namespace the list stays one group in its own order", () => {
		expect(groupMonitors([unseen, unlinked], {})).toEqual([[NO_NAMESPACE, [unseen, unlinked]]])
	})
})
