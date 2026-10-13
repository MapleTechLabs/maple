/// <reference types="@types/bun" />
/**
 * Renders every sample variant through the production runtime and drops the
 * HTML in /tmp for eyeballing. Replaces the old `email dev` server — there is
 * no server to run any more, the renderers are pure functions.
 *
 * Usage: bun run --cwd packages/email preview
 */
import { renderAlertNotification } from "../src/alert-notification"
import {
	alertNotificationProps,
	criticalDigestProps,
	healthyDigestProps,
	multiEnvDigestProps,
	scopedDigestProps,
	quietWebAnalyticsDigestProps,
	watchDigestProps,
	webAnalyticsDigestProps,
} from "../src/samples"
import { renderWeeklyDigest } from "../src/weekly-digest"
import { renderWebAnalyticsDigest } from "../src/web-analytics-digest"

const OUT_DIR = "/tmp/maple-email-preview"

const variants: ReadonlyArray<{ name: string; html: string }> = [
	{ name: "weekly-digest-healthy", html: renderWeeklyDigest(healthyDigestProps) },
	{ name: "weekly-digest-watch", html: renderWeeklyDigest(watchDigestProps) },
	{ name: "weekly-digest-critical", html: renderWeeklyDigest(criticalDigestProps) },
	{ name: "weekly-digest-multi-env", html: renderWeeklyDigest(multiEnvDigestProps) },
	{ name: "weekly-digest-scoped", html: renderWeeklyDigest(scopedDigestProps) },
	{ name: "web-analytics-digest", html: renderWebAnalyticsDigest(webAnalyticsDigestProps) },
	{ name: "web-analytics-digest-quiet", html: renderWebAnalyticsDigest(quietWebAnalyticsDigestProps) },
	{ name: "alert-notification", html: renderAlertNotification(alertNotificationProps) },
]

// Icons are served from maple.dev once the landing site deploys; point the
// preview at the local PNGs so new icons show before that.
const LOCAL_ICONS = `file://${new URL("../../../apps/landing/public/email/icons", import.meta.url).pathname}`

for (const { name, html: rendered } of variants) {
	const path = `${OUT_DIR}/${name}.html`
	const html = rendered.replaceAll("https://maple.dev/email/icons", LOCAL_ICONS)
	await Bun.write(path, html)
	console.log(`${path} (${html.length} chars)`)
}
