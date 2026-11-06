// Vite types unknown keys as `any`; every `VITE_*` the dashboard reads is declared here.
interface ImportMetaEnv {
	readonly VITE_API_BASE_URL?: string
	readonly VITE_API_PUBLIC_URL?: string
	readonly VITE_CLERK_PUBLISHABLE_KEY?: string
	readonly VITE_CLERK_SIGN_IN_URL?: string
	readonly VITE_CLERK_SIGN_UP_URL?: string
	readonly VITE_COMMIT_SHA?: string
	readonly VITE_ELECTRIC_SYNC_DISABLED?: string
	readonly VITE_ELECTRIC_SYNC_URL?: string
	readonly VITE_INGEST_URL?: string
	readonly VITE_MAPLE_AUTH_MODE?: string
	readonly VITE_MAPLE_CAPTURE?: string
	readonly VITE_MAPLE_COOKIE_DOMAIN?: string
	readonly VITE_MAPLE_ENVIRONMENT?: string
	readonly VITE_MAPLE_INGEST_KEY?: string
	readonly VITE_MAPLE_LAB?: string
	readonly VITE_MAPLE_REGION?: string
	readonly VITE_MAPLE_REGION_APP_URLS?: string
	readonly VITE_MAPLE_REPLAY?: string
	readonly VITE_MAPLE_SELF_INGEST_URL?: string
	readonly VITE_MCP_URL?: string
	readonly VITE_STATUS_PAGE_BASE_URL?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
