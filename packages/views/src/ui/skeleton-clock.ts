import { Array as Arr } from "effect"

/** The sweeps of `skeleton` (`::before`) and `chartSkeleton`, by keyframes name. */
const SWEEPS: ReadonlySet<string> = new Set(["skeleton", "chart-skeleton-sweep"])

const isSweep = (animation: Animation): animation is CSSAnimation =>
	animation instanceof CSSAnimation && SWEEPS.has(animation.animationName)

const alignSweep = (event: AnimationEvent): void => {
	if (!SWEEPS.has(event.animationName) || !(event.target instanceof Element)) return
	Arr.forEach(Arr.filter(event.target.getAnimations({ subtree: true }), isSweep), (animation) => {
		animation.startTime = 0
	})
}

/**
 * Every skeleton sweep runs on one clock. A CSS animation starts when its element mounts, so
 * skeletons mounted at different moments sweep out of step; one capture listener starts each sweep
 * at the document timeline's origin, so every band on screen crosses together.
 */
export const syncSkeletonSweeps = (target: Document = document): void => {
	target.addEventListener("animationstart", alignSweep, true)
}
