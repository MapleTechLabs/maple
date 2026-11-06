/**
 * A full 40-hex SHA, or an abbreviated one (7 to 39 hex) with at least one
 * letter: an all-digit version like a date build number is not a commit.
 */
export const isCommitSha = (value: string | undefined): value is string =>
	value !== undefined &&
	(/^[0-9a-f]{40}$/i.test(value) || (/^[0-9a-f]{7,39}$/i.test(value) && /[a-f]/i.test(value)))
