import type { DatasetSummary } from "../contract.ts"

/**
 * Browser state a capture starts from, installed with `page.addInitScript` before app code runs.
 * The `install*` functions are serialized via `toString`, so they must be self-contained.
 */

const TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The bearer the self-hosted app sends: JWT-shaped (unsigned) with the dataset's org in `org_id`,
 * which is what `src/backend/auth.ts` checks. `exp` is 30 days past the frozen clock, so the app's
 * `readJwtExpMs` never schedules a renewal during a capture. `null` for signed-out datasets.
 */
export const selfHostedTokenFor = (dataset: DatasetSummary): string | null => {
	if (dataset.identity === null) return null
	const encode = (value: Readonly<Record<string, string | number>>) =>
		Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
	const exp = Math.floor((new Date(dataset.now).getTime() + TOKEN_LIFETIME_MS) / 1000)
	const claims = {
		sub: dataset.identity.userId,
		org_id: dataset.identity.orgId,
		dataset: dataset.name,
		exp,
	}
	return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.parity-fixture`
}

/**
 * Signs the self-hosted app in. Mirrors `apps/web/src/lib/services/common/self-hosted-auth.ts`:
 * the token lives in **sessionStorage** under `maple.self_hosted.token`.
 */
export const installSelfHostedSession = (token: string | null) => {
	const key = "maple.self_hosted.token"
	if (token === null) window.sessionStorage.removeItem(key)
	else window.sessionStorage.setItem(key, token)
}

/**
 * Picks the theme. Mirrors the pre-paint script in `apps/web/index.html` and `@maple/ui/hooks/use-theme`:
 * localStorage `maple-theme` = `light` | `dark`, applied as a class on `<html>`.
 */
export const installTheme = (theme: "light" | "dark") => {
	window.localStorage.setItem("maple-theme", theme)
}
