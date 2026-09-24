// One-shot "telemetry disabled" notice.
//
// The env-driven presets (server layer, server flushable, Cloudflare) disable
// themselves on the same condition — no ingest key resolved — and each needs to
// say so exactly once, so a developer running locally sees why nothing arrives
// instead of silently believing telemetry works. Sharing the wording keeps that
// message identical across presets. The browser client never disables: its key
// is auth only (see `buildResolved`'s `keyless`).

export const makeNoOpNotice = (logPrefix: string, enableHint: string): (() => void) => {
	let logged = false
	return () => {
		if (logged) return
		logged = true
		console.info(`${logPrefix} no ingest key configured — telemetry disabled (${enableHint})`)
	}
}
