import type { ReactNode } from "react"

export function AuthLayout({ children, maxWidth = "max-w-sm" }: { children: ReactNode; maxWidth?: string }) {
	return (
		<main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 py-10 sm:p-6">
			{/* Grid pattern — stronger lines, radial fade. Desktop only: on phones the form sits straight on the page and the lines run through it. */}
			<div
				className="pointer-events-none absolute inset-0 -z-10 hidden sm:block"
				style={{
					backgroundImage: [
						"linear-gradient(to right, oklch(0.91 0.016 74 / 8%) 1px, transparent 1px)",
						"linear-gradient(to bottom, oklch(0.91 0.016 74 / 8%) 1px, transparent 1px)",
					].join(", "),
					backgroundSize: "60px 60px",
					maskImage: "radial-gradient(ellipse 70% 60% at 50% 40%, black, transparent)",
				}}
			/>

			{/* Accent glow — centered behind the card area */}
			<div
				className="absolute -z-10 pointer-events-none"
				style={{
					width: "600px",
					height: "400px",
					top: "50%",
					left: "50%",
					transform: "translate(-50%, -50%)",
					background:
						"radial-gradient(ellipse at center, oklch(0.714 0.154 59 / 0.12) 0%, oklch(0.714 0.154 59 / 0.04) 40%, transparent 70%)",
				}}
			/>

			<p className="mb-6 text-lg font-semibold tracking-tight text-foreground">maple</p>
			{/* Phones get the form straight on the page; the card chrome only earns its space from sm: up. */}
			<div className={`relative w-full ${maxWidth} sm:border sm:border-border sm:bg-card sm:p-6`}>
				{children}
			</div>
		</main>
	)
}
