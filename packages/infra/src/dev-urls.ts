import { Array as Arr, String as Str } from "effect"
/** Every app `bun dev` can run. */
export const DEV_APPS = [
	"api",
	"ai",
	"alerting",
	"chat-bot",
	"electric-sync",
	"status",
	"web",
	"landing",
	"ingest",
	"local-ui",
	"scraper",
] as const

export type DevApp = (typeof DEV_APPS)[number]

/** The apps that run their own `dev` script as a child process; the rest are Workers on alchemy's local runtime. */
export const DEV_PROCESS_APPS = [
	"landing",
	"ingest",
	"local-ui",
	"scraper",
] as const satisfies ReadonlyArray<DevApp>

export const isDevApp = (value: string): value is DevApp =>
	(DEV_APPS as ReadonlyArray<string>).includes(value)

/** Comma-separated subset of `DEV_APPS` this `alchemy dev` run was asked for; unset = all. */
export const DEV_APPS_ENV_KEY = "MAPLE_DEV_APPS"

/** The apps this dev run serves: all of them unless `bun dev` named a subset. */
export const selectedDevApps = (): ReadonlySet<DevApp> => {
	const value = process.env[DEV_APPS_ENV_KEY]
	const raw = value === undefined ? undefined : Str.trim(value)
	if (!raw) return new Set(DEV_APPS)
	const selected = Arr.filter(
		Arr.map(Str.split(",")(raw), (name) => Str.trim(name)),
		isDevApp,
	)
	return selected.length > 0 ? new Set(selected) : new Set(DEV_APPS)
}

/** A sibling app's URL from this app's own `PORTLESS_URL`, branch prefix included. */
export const siblingUrl = (target: string): string | undefined => {
	const self = process.env.PORTLESS_URL
	if (!self) return undefined
	const url = new URL(self)
	const parts = Str.split(".")(url.hostname)
	const localhostIdx = parts.lastIndexOf("localhost")
	if (localhostIdx < 1) return undefined
	parts[localhostIdx - 1] = target
	return `${url.protocol}//${Arr.join(parts, ".")}${url.port ? `:${url.port}` : ""}`
}
