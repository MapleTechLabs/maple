import { Array as Arr, String as Str } from "effect"
/**
 * The clerk-js build the dashboard and the marketing site run, pinned so the app's index.html can
 * preload the exact file (`@5` answers with an uncacheable redirect) and both share one cached copy.
 * No dependency tracks it: bump it by hand to the version `@5` redirects to.
 */
export const CLERK_JS_VERSION = "5.128.0"

/** `pk_<env>_<base64(frontendApi$)>`: clerk-js from the instance's own Frontend API, as `<ClerkProvider>` loads it. */
export const clerkJsUrl = (publishableKey: string): string =>
	`https://${Str.replace(/\$$/, "")(atob(Arr.join(Str.split("_")(publishableKey).slice(2), "_")))}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`

/**
 * Clerk's per-instance cookie suffix: base64url(sha1(publishableKey)),
 * first 8 chars — mirrors `getCookieSuffix` in @clerk/shared.
 */
export async function computeClerkCookieSuffix(
	publishableKey: string,
	subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
	const digest = await subtle.digest("SHA-1", new TextEncoder().encode(publishableKey))
	const bytes = Array.from(new Uint8Array(digest))
	return Str.replace(
		/\//g,
		"_",
	)(Str.replace(/\+/g, "-")(btoa(String.fromCharCode(...bytes)))).substring(0, 8)
}
