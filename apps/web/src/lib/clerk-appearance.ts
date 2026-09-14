import { dark } from "@clerk/themes"

// Provider-wide theme: every Clerk surface (user button popover, re-verification
// modal, organization switcher) keeps its own card chrome on top of these tokens.
export const clerkAppearance = {
	baseTheme: dark,
	variables: {
		colorBackground: "oklch(0.207 0.008 67)",
		colorInputBackground: "oklch(0.33 0.015 72)",
		colorText: "oklch(0.91 0.016 74)",
		colorTextSecondary: "oklch(0.603 0.023 72)",
		colorPrimary: "oklch(0.714 0.154 59)",
		colorDanger: "oklch(0.654 0.176 30)",
		colorInputText: "oklch(0.91 0.016 74)",
		borderRadius: "0px",
		fontFamily: "'Geist Mono Variable', monospace",
	},
}

// <SignIn> / <SignUp> render inside AuthLayout, which already draws the card and
// wordmark. Clerk's card is a fixed 25rem with its own padding, shadow and logo,
// so it overflowed the wrapper on every viewport and doubled up on phones.
// Object styles are required here: class strings lose to Clerk's runtime CSS.
export const clerkAuthCardAppearance = {
	...clerkAppearance,
	layout: {
		logoPlacement: "none" as const,
	},
	elements: {
		rootBox: { width: "100%" },
		// Clerk's cardBox clips its overflow and relies on the card padding to absorb the
		// "Last used" badge, which hangs past the social button's top-right corner.
		cardBox: { width: "100%", maxWidth: "none", boxShadow: "none", overflow: "visible" },
		card: { width: "100%", padding: 0, background: "transparent", boxShadow: "none" },
		footer: { background: "transparent" },
	},
}
