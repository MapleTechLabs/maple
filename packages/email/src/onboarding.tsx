import type { ReactNode } from "react"
import {
	Body,
	Container,
	Head,
	Hr,
	Html,
	Link,
	Preview,
	Section,
	Tailwind,
	Text,
} from "@react-email/components"

/** Community support channels — shared across onboarding emails. */
const DISCORD_URL = "https://discord.gg/R76jTA4HbJ"
const BOOK_CALL_URL = "https://cal.com/david-granzin/30min"

/** OpenTelemetry quickstart in the public docs. */
const OTEL_QUICKSTART_URL = "https://maple.dev/docs/quickstart"

/**
 * Plain-text-feeling shell — no logo, no branded buttons, no orange accents.
 * The goal is to render like a personal note typed in Gmail, not a marketing
 * layout. CTAs are inline `<Link>` elements inside the body copy.
 */
const tailwindConfig = {
	theme: {
		extend: {
			colors: {
				body: "#222222",
				muted: "#666666",
				dim: "#999999",
				link: "#2563eb",
			},
			fontFamily: {
				sans: [
					"-apple-system",
					"BlinkMacSystemFont",
					"'Segoe UI'",
					"Roboto",
					"Helvetica",
					"Arial",
					"sans-serif",
				],
			},
		},
	},
}

interface ShellProps {
	preview: string
	children: ReactNode
	signoffName?: string
}

function PersonalEmailShell({ preview, children, signoffName = "David" }: ShellProps) {
	return (
		<Html>
			<Head />
			<Preview>{preview}</Preview>
			<Tailwind config={tailwindConfig}>
				<Body className="m-0 bg-white px-4 py-10 font-sans">
					<Container className="mx-auto max-w-[560px]">
						<Section>{children}</Section>

						<Section className="pt-3">
							<Text className="m-0 mb-1 text-[14px] leading-relaxed text-body">Cheers,</Text>
							<Text className="m-0 text-[14px] leading-relaxed text-body">{signoffName}</Text>
							<Text className="m-0 mt-1 text-[13px] leading-relaxed text-muted">
								Founder, Maple
							</Text>
						</Section>

						<Hr className="my-6 border-0 border-t border-[#eeeeee]" />

						<Section>
							<Text className="m-0 text-[11px] leading-relaxed text-dim">
								You're receiving this because you started a Maple workspace. Manage email
								preferences in your account settings.
							</Text>
						</Section>
					</Container>
				</Body>
			</Tailwind>
		</Html>
	)
}

/** Body paragraph — base sans-serif, near-black, comfortable line height. */
function Paragraph({ children }: { children: ReactNode }) {
	return <Text className="m-0 mb-4 text-[14px] leading-relaxed text-body">{children}</Text>
}

/** A single numbered tip rendered on its own line. */
function Tip({ index, children }: { index: number; children: ReactNode }) {
	return (
		<Text className="m-0 mb-2 text-[14px] leading-relaxed text-body">
			{index}. {children}
		</Text>
	)
}

/** Inline link styled like a plain hyperlink. */
function InlineLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<Link href={href} className="text-link underline">
			{children}
		</Link>
	)
}

/** P.S. paragraph — slightly muted, follows the tips. */
function PostScript({ children }: { children: ReactNode }) {
	return (
		<Text className="m-0 mb-4 mt-2 text-[14px] leading-relaxed text-body">
			<strong>P.S.</strong> {children}
		</Text>
	)
}

// -- Templates --

export interface WelcomeEmailProps {
	dashboardUrl: string
	trialDays?: number
}

export function WelcomeEmail({ dashboardUrl, trialDays }: WelcomeEmailProps) {
	return (
		<PersonalEmailShell preview="Welcome to Maple — a personal note from David">
			<Paragraph>Hey,</Paragraph>
			<Paragraph>My name is David — I'm the founder of Maple.</Paragraph>
			<Paragraph>
				We started Maple because we wanted observability that doesn't suck — no six-figure invoice, no
				sales call before you can see your first trace, just traces, logs, and metrics in one place
				the moment your services start sending them.
			</Paragraph>
			{trialDays ? (
				<Paragraph>
					Your {trialDays}-day trial is running. Here are 3 things to do to get value from it:
				</Paragraph>
			) : (
				<Paragraph>Here are 3 things to do to get started:</Paragraph>
			)}
			<Tip index={1}>
				<InlineLink href={dashboardUrl}>Open your setup checklist</InlineLink>
			</Tip>
			<Tip index={2}>
				<InlineLink href={dashboardUrl}>Send a test event from your dashboard</InlineLink>
			</Tip>
			<Tip index={3}>
				<InlineLink href={OTEL_QUICKSTART_URL}>Read the OpenTelemetry quickstart</InlineLink>
			</Tip>
			<PostScript>
				Why did you sign up? What are you trying to debug? Hit "Reply" and let me know — I read and
				reply to every email.
			</PostScript>
		</PersonalEmailShell>
	)
}

export interface ConnectAppEmailProps {
	dashboardUrl: string
}

export function ConnectAppEmail({ dashboardUrl }: ConnectAppEmailProps) {
	return (
		<PersonalEmailShell preview="Your Maple workspace is still waiting for data">
			<Paragraph>Hey, it's David again.</Paragraph>
			<Paragraph>
				Your workspace is set up, but I haven't seen any telemetry from your services yet. Maple only
				really becomes useful once your app is sending traces — so I wanted to nudge you with a few
				ways to get unblocked.
			</Paragraph>
			<Tip index={1}>
				<InlineLink href={dashboardUrl}>Open the setup checklist</InlineLink> — pick your stack and
				copy-paste the snippet.
			</Tip>
			<Tip index={2}>
				Paste a one-line prompt into Claude Code, Cursor, or Codex — it instruments your whole repo
				with OpenTelemetry automatically. The checklist has the prompt.
			</Tip>
			<Tip index={3}>Or grab the manual snippet for your language and drop it in.</Tip>
			<PostScript>
				Stuck on which exporter to use? Hit "Reply" with your stack and I'll point you at the right
				snippet.
			</PostScript>
		</PersonalEmailShell>
	)
}

export interface StalledEmailProps {
	dashboardUrl: string
}

export function StalledEmail({ dashboardUrl }: StalledEmailProps) {
	return (
		<PersonalEmailShell preview="Stuck connecting your app to Maple? I'd like to help">
			<Paragraph>Hey, it's David.</Paragraph>
			<Paragraph>
				It's been a few days and I haven't seen any telemetry land in your workspace. If something got
				in the way, I'd really like to know what.
			</Paragraph>
			<Paragraph>
				The usual culprits: the ingest key isn't on the exporter, the OTLP endpoint URL is missing the
				signal path (`/v1/traces`, `/v1/logs`…), or the service hasn't been redeployed yet.
			</Paragraph>
			<Paragraph>Three faster ways to get unstuck:</Paragraph>
			<Tip index={1}>
				<InlineLink href={dashboardUrl}>Open the setup checklist</InlineLink> — it has copy-paste
				snippets for every supported stack.
			</Tip>
			<Tip index={2}>
				<InlineLink href={DISCORD_URL}>Ping me in our Discord</InlineLink> — quick questions get quick
				answers.
			</Tip>
			<Tip index={3}>
				<InlineLink href={BOOK_CALL_URL}>Book 30 minutes with me</InlineLink> — we'll walk through
				setup live.
			</Tip>
			<PostScript>
				What got you stuck? Even a one-line reply helps me figure out what to fix next — I read every
				one.
			</PostScript>
		</PersonalEmailShell>
	)
}

export interface ActivationEmailProps {
	dashboardUrl: string
	serviceName?: string
}

export function ActivationEmail({ dashboardUrl, serviceName }: ActivationEmailProps) {
	return (
		<PersonalEmailShell preview="Your first trace landed in Maple — you're live">
			<Paragraph>Hey, it's David.</Paragraph>
			<Paragraph>
				Just saw the first traces land from <strong>{serviceName ?? "your services"}</strong>. You're
				live on Maple.
			</Paragraph>
			<Paragraph>Three things worth trying today:</Paragraph>
			<Tip index={1}>
				<InlineLink href={dashboardUrl}>Open a slow trace</InlineLink> and walk the span waterfall —
				that's usually where the surprises are.
			</Tip>
			<Tip index={2}>
				<InlineLink href={dashboardUrl}>Check the service map</InlineLink> to see how your services
				call each other.
			</Tip>
			<Tip index={3}>
				<InlineLink href={dashboardUrl}>Wire up your first alert</InlineLink> so Maple tells you when
				something breaks.
			</Tip>
			<PostScript>
				What's the first thing you want Maple to catch for you? Hit "Reply" and tell me — it genuinely
				helps me prioritize what we build next.
			</PostScript>
		</PersonalEmailShell>
	)
}
