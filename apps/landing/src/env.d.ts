// Astro types unknown env keys as `any`; every key the site reads is declared here.
interface ImportMetaEnv {
	readonly AUTUMN_SECRET_KEY?: string
	readonly GITHUB_TOKEN?: string
	readonly PUBLIC_CLERK_PUBLISHABLE_KEY?: string
	readonly PUBLIC_INGEST_URL?: string
	readonly PUBLIC_MAPLE_COOKIE_DOMAIN?: string
	readonly PUBLIC_MAPLE_INGEST_KEY?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
