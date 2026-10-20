/**
 * The clerk-js build the app runs, pinned so index.html can preload the exact file
 * (`@5` answers with an uncacheable redirect). No dependency tracks it: bump it by hand
 * to the version `@5` redirects to.
 */
export const CLERK_JS_VERSION = "5.128.0"

/** `pk_<env>_<base64(frontendApi$)>`: clerk-js from the instance's own Frontend API, as `<ClerkProvider>` loads it. */
export const clerkJsUrl = (publishableKey: string): string =>
	`https://${atob(publishableKey.split("_").slice(2).join("_")).replace(/\$$/, "")}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`
