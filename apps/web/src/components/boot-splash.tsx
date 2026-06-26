/**
 * Branded cold-boot loading state.
 *
 * Shown in the brief windows where the app has nothing to render yet — while
 * Clerk auth settles (`main.tsx`) and while the customer/plan query resolves
 * (`__root.tsx`). Replaces both the blank screen and the bare radial spinner.
 *
 * The signature is a trace-waterfall: an amber Maple mark above three indented
 * "span" bars with a soft amber shimmer sweeping through them in sequence —
 * Maple's own material (a trace) standing in for a generic loader. Motion lives
 * only in the bars; the mark stays still. Reduced motion settles the bars to a
 * static amber fill (see the `.boot-span` rules in `styles.css`).
 *
 * An inline, JS-free copy of this lives inside `#app` in `index.html` so the
 * very first paint already shows it; React replaces that copy with this
 * component on mount, and since they look identical there is no blank frame and
 * no flash at the handoff. Keep the two visually in sync.
 */
export function BootSplash() {
	return (
		<main
			role="status"
			aria-label="Loading Maple"
			className="flex min-h-screen w-full flex-col items-center justify-center gap-6 bg-background"
		>
			<div className="boot-mark size-11 rounded-[11px]">
				<svg
					viewBox="0 0 24 24"
					width={24}
					height={24}
					fill="none"
					stroke="#fff"
					strokeWidth={2.4}
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M5 18V7l7 7 7-7v11" />
				</svg>
			</div>
			<div className="boot-trace" aria-hidden="true">
				<span className="boot-span boot-span--1" />
				<span className="boot-span boot-span--2" />
				<span className="boot-span boot-span--3" />
			</div>
			<span className="sr-only">Loading…</span>
		</main>
	)
}
