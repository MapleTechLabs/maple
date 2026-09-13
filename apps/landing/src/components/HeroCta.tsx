import { useEffect, useState } from "react"
import * as m from "../paraglide/messages.js"
import { APP_SIGN_UP_URL, APP_URL } from "../lib/app-urls"
import { SIGNED_IN_EVENT } from "./auth-signal"

/**
 * Hero "Start free trial" link that flips to "Dashboard" when the user is signed in.
 * Clerk must only be mounted once per page (a second ClerkProvider island crashes the
 * first), so this listens to the auth signal broadcast by the NavBar island instead.
 */
export function HeroCta({ className }: { className?: string }) {
	const [signedIn, setSignedIn] = useState(false)
	useEffect(() => {
		setSignedIn(window.__mapleSignedIn === true)
		const onChange = (event: Event) => setSignedIn((event as CustomEvent<boolean>).detail === true)
		document.addEventListener(SIGNED_IN_EVENT, onChange)
		return () => document.removeEventListener(SIGNED_IN_EVENT, onChange)
	}, [])
	const href = signedIn ? APP_URL : APP_SIGN_UP_URL
	const label = signedIn ? m.nav_dashboard() : m.cta_get_started()
	return (
		<a
			href={href}
			data-hero-cta
			data-track="cta_click"
			data-track-location="hero"
			// `location` alone cannot separate "the hero CTA converts" from "the
			// hero CTA sends signed-in visitors back to their dashboard" — the
			// two are the same event on the same element with different intent.
			data-track-label={label}
			data-track-destination={href}
			className={className}
		>
			{label}
		</a>
	)
}
