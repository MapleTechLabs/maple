import type { ReactNode } from "react"
import { MapleMark } from "@maple/ui/components/icons/maple-mark"
import "./account-layout.css"

/* THESIS: The landing page's architectural world becomes the entrance to Maple.
 * OWN-WORLD: Warm charcoal, orange engraving, bold Geist, square controls.
 * STORY: Recognize Maple, then sign in or create an account without distraction.
 * FIRST VIEWPORT: Full-height artwork on the left; an unboxed form on the right.
 * FORM: An illustrated threshold; compact branding replaces the artwork on phones.
 */
export function AccountLayout({ children }: { children: ReactNode }) {
	return (
		<main className="account-layout dark">
			{/* Decorative panel: the form owns the page's only heading, so the art copy
			 * is styled display type rather than an <h2> landing ahead of that <h1>. */}
			<aside className="account-art">
				<img
					src="/art/maple-auth-arch.webp"
					alt=""
					className="account-art-image"
					fetchPriority="high"
				/>
				<a className="account-wordmark" href="https://maple.dev" aria-label="Maple home">
					<MapleMark size={30} aria-hidden="true" />
					<span>Maple</span>
				</a>
				<div className="account-art-copy">
					<p className="account-eyebrow">Open-source observability</p>
					<p className="account-art-headline">
						Understand
						<br />
						what’s happening.
					</p>
					<p>
						Traces, logs, and metrics.
						<br />
						One place to see the whole picture.
					</p>
				</div>
			</aside>
			<section className="account-content" aria-label="Your Maple account">
				<header className="account-header">
					<a className="account-mobile-wordmark" href="https://maple.dev" aria-label="Maple home">
						<MapleMark size={26} aria-hidden="true" />
						<span>Maple</span>
					</a>
					<a className="account-back" href="https://maple.dev">
						Back to website
					</a>
				</header>
				<div className="account-form">{children}</div>
				<footer className="account-footer">
					<span>Built on OpenTelemetry.</span>
					<a href="https://maple.dev/docs">Documentation</a>
				</footer>
			</section>
		</main>
	)
}
