import type { IconProps } from "./icon"

/**
 * PLACEHOLDER, not Google's brand asset.
 *
 * Every other third-party mark in this directory carries a `Source: simple-icons (MIT)` line and
 * that project's exact path data. simple-icons is not vendored in this repo, so rather than
 * inventing a path and attributing it to them — a false citation someone would later take at face
 * value — this is a plain geometric ascending-bars glyph in GA's brand orange.
 *
 * It reads correctly at catalog size (GA4's own mark is a bar arrangement), but before this ships
 * to customers, replace the paths below with `simpleicons.org/icons/googleanalytics` and restore
 * the attribution comment. Keep `currentColor` and the `size`/`className` contract.
 */
function GoogleAnalyticsIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="currentColor"
			aria-hidden="true"
			{...props}
		>
			<rect x="3" y="14" width="4.5" height="7" rx="2.25" />
			<rect x="9.75" y="9" width="4.5" height="12" rx="2.25" />
			<rect x="16.5" y="3" width="4.5" height="18" rx="2.25" />
		</svg>
	)
}

export { GoogleAnalyticsIcon }
