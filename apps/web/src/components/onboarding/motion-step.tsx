import type { ReactNode } from "react"
import { motion, useReducedMotion } from "motion/react"

export const STEP_MOTION = {
	duration: 0.28,
	ease: [0.16, 1, 0.3, 1] as const,
}

export function MotionStep({ children, direction }: { children: ReactNode; direction: number }) {
	const reduceMotion = useReducedMotion()
	return (
		<motion.div
			custom={direction}
			initial={{ opacity: 0, x: reduceMotion ? 0 : direction * 24 }}
			animate={{ opacity: 1, x: 0 }}
			exit={{ opacity: 0, x: reduceMotion ? 0 : direction * -24 }}
			transition={reduceMotion ? { duration: 0 } : STEP_MOTION}
			className="flex flex-1 flex-col"
		>
			{children}
		</motion.div>
	)
}
