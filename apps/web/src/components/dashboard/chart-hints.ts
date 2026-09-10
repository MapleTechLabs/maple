/**
 * Explanatory copy for metric cards whose name says nothing about how the
 * number is built. Kept out of the route files so the service and release
 * overviews describe the same chart the same way.
 */
export const APDEX_HINT =
	"Apdex scores how many requests felt fast. With a 500ms target, a request under 500ms is satisfied (1 point), one under 2s is tolerating (½ point), and anything slower — or any failed request — scores 0. The score is that total divided by all requests, so 1.0 means every request was fast and 0 means none were."
