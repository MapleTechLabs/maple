import type { ClerkProviderProps } from "@clerk/clerk-react"
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

// <SignIn> / <SignUp> render inside AccountLayout, which supplies the page and
// wordmark. Clerk's card is a fixed 25rem with its own padding, shadow and logo,
// so it overflowed the wrapper on every viewport and doubled up on phones.
// Object styles are required here: class strings lose to Clerk's runtime CSS.
export const clerkAuthCardAppearance = {
	...clerkAppearance,
	variables: {
		// fontFamily is inherited from the provider theme: Geist Mono is Maple's
		// body and label voice, and only the header lines below go proportional.
		...clerkAppearance.variables,
		// Clerk derives every border, hover fill and backdrop from `colorNeutral`,
		// whose dark-theme default is white — which put neutral-white hairlines on a
		// warm-gray canvas. Seeding it with our foreground keeps the whole card warm.
		colorNeutral: "oklch(0.91 0.016 74)",
		colorForeground: "oklch(0.91 0.016 74)",
		colorMutedForeground: "oklch(0.603 0.023 72)",
		colorMuted: "oklch(0.26 0.012 67)",
		colorBorder: "oklch(0.33 0.015 72)",
		// The form is unboxed on --background, so a field needs its own tonal step to
		// read as a field: --input at the 32% the app's own <Input> uses, flattened.
		colorInput: "oklch(0.246 0.01 70)",
		colorInputBackground: "oklch(0.246 0.01 70)",
		colorInputForeground: "oklch(0.91 0.016 74)",
		// Clerk's default is #000 on the accent; the system bans pure black.
		colorPrimaryForeground: "oklch(0.207 0.008 67)",
		colorRing: "oklch(0.58 0.02 65)",
		colorWarning: "oklch(0.8 0.15 84)",
		colorSuccess: "oklch(0.658 0.134 151)",
		colorShadow: "oklch(0.207 0.008 67)",
	},
	layout: {
		logoPlacement: "none" as const,
		// The striped "Development mode" strip is Clerk's own chrome, not a Maple state.
		unsafe_disableDevelopmentModeWarnings: true,
	},
	elements: {
		rootBox: { width: "100%" },
		// Clerk's cardBox clips its overflow and relies on the card padding to absorb the
		// "Last used" badge, which hangs past the social button's top-right corner.
		cardBox: { width: "100%", maxWidth: "none", boxShadow: "none", overflow: "visible" },
		// Clerk centers the whole card; the layout around it is left-aligned.
		card: { width: "100%", padding: 0, background: "transparent", boxShadow: "none", textAlign: "left" },
		header: { textAlign: "left" },
		headerTitle: {
			fontFamily: "'Geist Variable', sans-serif",
			fontSize: "30px",
			fontWeight: 650,
			letterSpacing: "-0.03em",
			lineHeight: 1.1,
		},
		headerSubtitle: {
			fontFamily: "'Geist Variable', sans-serif",
			fontSize: "14px",
			lineHeight: "1.6",
		},
		socialButtonsBlockButton: { minHeight: "44px", borderRadius: 0, boxShadow: "none" },
		formFieldInput: { minHeight: "44px", borderRadius: 0, boxShadow: "none" },
		formButtonPrimary: { minHeight: "44px", borderRadius: 0, boxShadow: "none" },
		footer: { background: "transparent", padding: "24px 0 0" },
		footerAction: { justifyContent: "flex-start" },
	},
}

// Clerk's stock strings ("Welcome back! Please sign in to continue") carry the
// exclamation points and reassurance the product voice rules out. Only the two
// entry cards are overridden; every other Clerk surface keeps its own copy.
type ClerkLocalization = NonNullable<ClerkProviderProps["localization"]>

export const clerkLocalization = {
	signIn: {
		start: {
			title: "Sign in to Maple",
			subtitle: "Continue to your traces, logs, and metrics.",
		},
	},
	signUp: {
		start: {
			title: "Create your account",
			subtitle: "Connect a service and start sending telemetry.",
		},
	},
} satisfies ClerkLocalization
