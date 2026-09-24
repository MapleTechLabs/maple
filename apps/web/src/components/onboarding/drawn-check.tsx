import { motion, useReducedMotion } from "motion/react"
import { cn } from "@maple/ui/lib/utils"

/**
 * The selection mark shared by the onboarding cards. The tick draws in the
 * way the intent diagrams' links do, instead of bouncing or zooming.
 */
export function DrawnCheck({ checked, className }: { checked: boolean; className?: string }) {
	const reduceMotion = useReducedMotion()
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-4 shrink-0 items-center justify-center rounded-[.25rem] border transition-[color,background-color,border-color,opacity] duration-150 motion-reduce:transition-none",
				checked
					? "border-primary bg-primary text-primary-foreground"
					: "border-input bg-background group-hover:border-foreground/40",
				className,
			)}
		>
			<svg viewBox="0 0 24 24" className="size-3" fill="none">
				<motion.path
					d="M5.252 12.7 10.2 18.63 18.748 5.37"
					stroke="currentColor"
					strokeWidth="3"
					strokeLinecap="round"
					strokeLinejoin="round"
					initial={false}
					animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
					transition={
						reduceMotion
							? { duration: 0 }
							: { duration: 0.24, ease: [0.16, 1, 0.3, 1], delay: checked ? 0.08 : 0 }
					}
				/>
			</svg>
		</span>
	)
}
