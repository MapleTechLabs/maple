import type { V2UptimeMonitorConfig } from "@maple/domain/http/v2"
import { parseHeartbeatCron } from "@maple/domain/uptime"
import { Option } from "effect"
import type { UptimeMonitor } from "../shared/uptime-derive"
import { type AssertionDraft, type Form, emptyForm } from "./form"

// The form's checks, its wire payload, and the form an existing monitor opens as.

const isWhole = (value: string) => /^\d+$/u.test(value.trim())
const whole = (value: string) => Number.parseInt(value.trim(), 10)
const isHttpUrl = (value: string) => {
	const trimmed = value.trim()
	return /^https?:\/\/\S+$/u.test(trimmed) && URL.canParse(trimmed)
}

/** `api.acme.dev/health` from a URL, the default name of an HTTP check. */
export const nameFromUrl = (url: string): string => {
	const bare = url.trim().replace(/^https?:\/\//u, "")
	return bare.replace(/[?#].*$/u, "").replace(/\/$/u, "")
}

/** The name a check takes until one is typed; a heartbeat has no target to name it after. */
export const defaultName = (form: Form): string => {
	switch (form.kind) {
		case "http":
			return nameFromUrl(form.url)
		case "tcp":
			return form.host.trim() === ""
				? ""
				: form.port.trim() === ""
					? form.host.trim()
					: `${form.host.trim()}:${form.port.trim()}`
		case "dns":
			return form.hostname.trim() === "" ? "" : `${form.recordType} ${form.hostname.trim()}`
		case "heartbeat":
			return form.name
	}
}

// Obvious private targets, refused here with the server's sentences; the server stays authoritative.
const BLOCKED_NAMES = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"])
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal"]
const PRIVATE_V4 = [
	/^0\./u,
	/^10\./u,
	/^127\./u,
	/^169\.254\./u,
	/^192\.168\./u,
	/^172\.(1[6-9]|2\d|3[01])\./u,
	/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u,
]
const PRIVATE_V6 = [/^::1?$/u, /^f[cd][0-9a-f]{0,2}:/u, /^fe[89ab][0-9a-f]?:/u, /^::ffff:/u]

const isIpLiteral = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/u.test(host) || host.includes(":")

/** True for a loopback, private, link-local or metadata host, by name or literal address. */
export const isPrivateHost = (raw: string): boolean => {
	const host = raw
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/gu, "")
		.replace(/\.$/u, "")
	if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
	if (host.includes(":")) return PRIVATE_V6.some((pattern) => pattern.test(host))
	// Only a literal address: `10.example.com` is a public name.
	return isIpLiteral(host) && PRIVATE_V4.some((pattern) => pattern.test(host))
}

const urlHostOf = (url: string): string | null =>
	URL.canParse(url.trim()) ? new URL(url.trim()).hostname : null

const hostIssue = (host: string): ReadonlyArray<string> =>
	host.trim() !== "" && isPrivateHost(host)
		? [
				isIpLiteral(host.trim().replace(/^\[|\]$/gu, ""))
					? `Host '${host.trim()}' is not allowed (loopback, private, or metadata range)`
					: `URL host '${host.trim()}' is not allowed (loopback, private, or metadata range)`,
			]
		: []

const STATUS_PATTERN = /^([1-5]xx|[1-5]\d\d)$/u

const assertionIssue = (row: AssertionDraft): string | null => {
	switch (row.type) {
		case "status":
			return STATUS_PATTERN.test(row.value.trim())
				? null
				: "A status check needs a class like 2xx or a code like 204."
		case "latency":
			// The wire value is an Int: a huge digit run would serialize as null and fail the save.
			return isWhole(row.value) && whole(row.value) > 0 && Number.isSafeInteger(whole(row.value))
				? null
				: "A response time check needs a whole number of milliseconds."
		case "body":
			return row.value.trim() === "" ? "A body check needs the text to look for." : null
		case "json_path":
			return row.target.trim() === ""
				? "A JSON path check needs a path like $.status."
				: row.op === "equals" && row.value.trim() === ""
					? "A JSON path check needs the value to compare with."
					: null
		case "header":
			return row.target.trim() === ""
				? "A header check needs the header name."
				: row.op !== "exists" && row.value.trim() === ""
					? "A header check needs the value to compare with."
					: null
	}
}

const EVERY_SECONDS = { seconds: 1, minutes: 60, hours: 3600 } as const

export const everySeconds = (form: Form): number =>
	isWhole(form.everyValue) ? whole(form.everyValue) * EVERY_SECONDS[form.everyUnit] : Number.NaN

export const graceSeconds = (form: Form): number =>
	isWhole(form.graceValue) ? whole(form.graceValue) * EVERY_SECONDS[form.graceUnit] : Number.NaN

const MAX_GRACE_SECONDS = 86_400

/** What still blocks the save, one plain sentence each. */
/** A header line `parseHeaders` would skip, said out loud so the monitor is not saved without it. */
const headerLineIssues = (text: string): ReadonlyArray<string> =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && line.slice(0, Math.max(0, line.indexOf(":"))).trim() === "")
		.map((line) => `Header line '${line}' needs a name and a colon, like Authorization: Bearer token.`)

export const formIssues = (form: Form): ReadonlyArray<string> => {
	const add = (condition: boolean, issue: string): ReadonlyArray<string> => (condition ? [issue] : [])
	const kindIssues: ReadonlyArray<string> = (() => {
		switch (form.kind) {
			case "http":
				return [
					...add(form.url.trim() === "", "Add the URL to check."),
					...add(
						form.url.trim() !== "" && !isHttpUrl(form.url),
						"The URL must start with http:// or https://.",
					),
					...(() => {
						const host = urlHostOf(form.url)
						return host !== null && isPrivateHost(host)
							? [`URL host '${host}' is not allowed (loopback, private, or metadata range)`]
							: []
					})(),
					...headerLineIssues(form.headers),
					...new Set(
						form.assertions.flatMap((row) =>
							Option.toArray(Option.fromNullishOr(assertionIssue(row))),
						),
					),
				]
			case "tcp":
				return [
					...add(form.host.trim() === "", "Add the host to connect to."),
					...hostIssue(form.host),
					...add(
						!isWhole(form.port) || whole(form.port) < 1 || whole(form.port) > 65535,
						"The port must be a whole number from 1 to 65535.",
					),
				]
			case "dns":
				return [
					...add(form.hostname.trim() === "", "Add the hostname to resolve."),
					...hostIssue(form.hostname),
				]
			case "heartbeat":
				return form.scheduleMode === "interval"
					? add(!(everySeconds(form) >= 60), "Heartbeats expect a ping at most once a minute.")
					: form.cronExpression.trim() === ""
						? ["Add the cron expression of the job."]
						: add(
								Option.isNone(
									parseHeartbeatCron(form.cronExpression.trim(), form.cronTimezone),
								),
								`'${form.cronExpression.trim()}' in ${form.cronTimezone} is not a valid cron schedule`,
							)
		}
	})()
	const checkIssues =
		form.kind === "heartbeat"
			? add(
					!(graceSeconds(form) >= 0 && graceSeconds(form) <= MAX_GRACE_SECONDS),
					"The grace period must be 0 to 24 hours.",
				)
			: [
					...add(
						!isWhole(form.failuresToDown) ||
							whole(form.failuresToDown) < 1 ||
							whole(form.failuresToDown) > 10,
						"Down after must be 1 to 10 failed checks.",
					),
					...add(
						!isWhole(form.timeoutMs) ||
							whole(form.timeoutMs) < 1000 ||
							whole(form.timeoutMs) > 30000,
						"The timeout must be 1000 to 30000 ms.",
					),
				]
	return [...add(form.name.trim() === "", "Add a name."), ...kindIssues, ...checkIssues]
}

/** `Name: value` lines as a header record; lines without a colon are skipped. */
export const parseHeaders = (text: string): Readonly<Record<string, string>> =>
	Object.fromEntries(
		text.split("\n").flatMap((line) => {
			const index = line.indexOf(":")
			const name = index < 0 ? "" : line.slice(0, index).trim()
			return name === "" ? [] : [[name, line.slice(index + 1).trim()]]
		}),
	)

const assertionToWire = (row: AssertionDraft) => {
	switch (row.type) {
		case "status":
			return { type: "status", op: row.op, value: row.value.trim() }
		case "latency":
			return { type: "latency", under_ms: whole(row.value) }
		case "body":
			return { type: "body", op: row.op, value: row.value.trim() }
		case "json_path":
			return row.op === "exists"
				? { type: "json_path", path: row.target.trim(), op: "exists" }
				: { type: "json_path", path: row.target.trim(), op: row.op, value: row.value }
		case "header":
			return row.op === "exists"
				? { type: "header", name: row.target.trim(), op: "exists" }
				: {
						type: "header",
						name: row.target.trim(),
						op: row.op,
						value: row.op === "contains" ? row.value.trim() : row.value,
					}
	}
}

/** The wire config, as plain data the Command validates before sending. */
export const wireConfig = (form: Form): Readonly<Record<string, unknown>> => {
	const timeout = { timeout_ms: whole(form.timeoutMs) }
	switch (form.kind) {
		case "http":
			return {
				type: "http",
				url: form.url.trim(),
				method: form.method,
				headers: parseHeaders(form.headers),
				...(form.method === "POST" && form.body !== "" ? { body: form.body } : undefined),
				assertions: form.assertions.map(assertionToWire),
				...timeout,
			}
		case "tcp":
			return { type: "tcp", host: form.host.trim(), port: whole(form.port), ...timeout }
		case "dns":
			return {
				type: "dns",
				hostname: form.hostname.trim(),
				record_type: form.recordType,
				...(form.expected.trim() === "" ? undefined : { expected: form.expected.trim() }),
				...timeout,
			}
		case "heartbeat":
			return {
				type: "heartbeat",
				schedule:
					form.scheduleMode === "interval"
						? { type: "interval", seconds: everySeconds(form) }
						: {
								type: "cron",
								expression: form.cronExpression.trim(),
								timezone: form.cronTimezone,
							},
				grace_seconds: graceSeconds(form),
			}
	}
}

/** The create payload; an edit sends the same fields minus `kind`. */
export const wirePayload = (form: Form, isEdit: boolean): Readonly<Record<string, unknown>> => ({
	name: form.name.trim(),
	...(isEdit ? undefined : { kind: form.kind }),
	config: wireConfig(form),
	...(form.kind === "heartbeat"
		? undefined
		: { interval_seconds: form.intervalSeconds, failures_to_down: whole(form.failuresToDown) }),
	service_name: form.serviceName === "" ? null : form.serviceName,
	destination_ids: form.destinationIds,
})

const assertionFromWire = (
	assertion: NonNullable<Extract<V2UptimeMonitorConfig, { type: "http" }>["assertions"]>[number],
	id: number,
): AssertionDraft => {
	switch (assertion.type) {
		case "status":
			return { id, type: "status", op: assertion.op, target: "", value: assertion.value }
		case "latency":
			return { id, type: "latency", op: "under", target: "", value: String(assertion.under_ms) }
		case "body":
			return { id, type: "body", op: assertion.op, target: "", value: assertion.value }
		case "json_path":
			return {
				id,
				type: "json_path",
				op: assertion.op,
				target: assertion.path,
				value: assertion.op === "exists" ? "" : assertion.value,
			}
		case "header":
			return {
				id,
				type: "header",
				op: assertion.op,
				target: assertion.name,
				value: assertion.op === "exists" ? "" : assertion.value,
			}
	}
}

/** The largest unit that divides a heartbeat interval evenly. */
const everyOf = (seconds: number): Pick<Form, "everyValue" | "everyUnit"> =>
	seconds % 3600 === 0
		? { everyValue: String(seconds / 3600), everyUnit: "hours" }
		: seconds % 60 === 0
			? { everyValue: String(seconds / 60), everyUnit: "minutes" }
			: { everyValue: String(seconds), everyUnit: "seconds" }

export const formFromMonitor = (monitor: UptimeMonitor): Form => {
	const base = emptyForm({
		kind: monitor.kind,
		name: monitor.name,
		isNameEdited: true,
		intervalSeconds: monitor.interval_seconds,
		failuresToDown: String(monitor.failures_to_down),
		serviceName: monitor.service_name ?? "",
		destinationIds: monitor.destination_ids,
	})
	const config = monitor.config
	switch (config.type) {
		case "http": {
			const assertions = (config.assertions ?? []).map((assertion, index) =>
				assertionFromWire(assertion, index + 1),
			)
			return {
				...base,
				method: config.method ?? "GET",
				url: config.url,
				headers: Object.entries(config.headers ?? {})
					.map(([name, value]) => `${name}: ${value}`)
					.join("\n"),
				body: config.body ?? "",
				assertions,
				nextAssertionId: assertions.length + 1,
				timeoutMs: String(config.timeout_ms ?? 10000),
			}
		}
		case "tcp":
			return {
				...base,
				host: config.host,
				port: String(config.port),
				timeoutMs: String(config.timeout_ms ?? 10000),
			}
		case "dns":
			return {
				...base,
				hostname: config.hostname,
				recordType: config.record_type,
				expected: config.expected ?? "",
				timeoutMs: String(config.timeout_ms ?? 10000),
			}
		case "heartbeat":
			return {
				...base,
				...(config.grace_seconds % 60 === 0
					? { graceValue: String(config.grace_seconds / 60), graceUnit: "minutes" }
					: { graceValue: String(config.grace_seconds), graceUnit: "seconds" }),
				...(config.schedule.type === "interval"
					? { scheduleMode: "interval", ...everyOf(config.schedule.seconds) }
					: {
							scheduleMode: "cron",
							cronExpression: config.schedule.expression,
							cronTimezone: config.schedule.timezone,
						}),
			}
	}
}
