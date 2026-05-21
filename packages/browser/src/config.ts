/** Public configuration for `MapleBrowser.init`. */
export interface MapleBrowserConfig {
	/** Public ingest key (`maple_pk_...`). */
	readonly ingestKey: string
	/** Service name reported on traces and stored on replay sessions. */
	readonly serviceName: string
	/** Maple ingest base URL. Defaults to `https://ingest.maple.dev`. */
	readonly endpoint?: string
	/** Service version / commit SHA. */
	readonly serviceVersion?: string
	/** Deployment environment, e.g. "production". */
	readonly environment?: string
	/** Optional user id attached to the replay session. */
	readonly userId?: string
	readonly tracing?: {
		/** Default true. */
		readonly enabled?: boolean
	}
	readonly replay?: {
		/** Default true. */
		readonly enabled?: boolean
		/** Fraction of sessions to record, 0–1. Default 1. */
		readonly sampleRate?: number
	}
	readonly privacy?: {
		/** Mask all `<input>` values. Default true. */
		readonly maskAllInputs?: boolean
	}
}

export interface ResolvedConfig {
	readonly ingestKey: string
	readonly serviceName: string
	readonly endpoint: string
	readonly serviceVersion: string | undefined
	readonly environment: string | undefined
	readonly userId: string | undefined
	readonly tracingEnabled: boolean
	readonly replayEnabled: boolean
	readonly replaySampleRate: number
	readonly maskAllInputs: boolean
}

const DEFAULT_ENDPOINT = "https://ingest.maple.dev"

export function resolveConfig(config: MapleBrowserConfig): ResolvedConfig {
	return {
		ingestKey: config.ingestKey,
		serviceName: config.serviceName,
		endpoint: (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, ""),
		serviceVersion: config.serviceVersion,
		environment: config.environment,
		userId: config.userId,
		tracingEnabled: config.tracing?.enabled ?? true,
		replayEnabled: config.replay?.enabled ?? true,
		replaySampleRate: config.replay?.sampleRate ?? 1,
		maskAllInputs: config.privacy?.maskAllInputs ?? true,
	}
}

/** ClickHouse-style `YYYY-MM-DD HH:MM:SS.mmm` in UTC (matches the ingest gateway). */
export function formatCHDateTime(date: Date): string {
	const pad = (n: number, width = 2) => String(n).padStart(width, "0")
	return (
		`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
		`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.` +
		`${pad(date.getUTCMilliseconds(), 3)}`
	)
}
