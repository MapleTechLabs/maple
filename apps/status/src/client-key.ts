import { Array as Arr, Option, String as Str } from "effect"

// Rate limit keys per client: an IPv4 address is one client, but one IPv6 customer holds a whole
// /64, so every address in it shares a key.

const HEX_GROUP = /^[0-9a-f]{1,4}$/iu
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u

/** The four bytes of a dotted IPv4 address, or none when it is not one. */
const ipv4Bytes = (address: string): Option.Option<ReadonlyArray<number>> =>
	Option.filter(
		Option.map(Option.fromNullishOr(IPV4.exec(address)), (match) =>
			Arr.map(match.slice(1), (part) => Number(part)),
		),
		(bytes) => bytes.length === 4 && Arr.every(bytes, (byte) => byte <= 255),
	)

/**
 * Colon-separated hex groups as numbers. With `endsAddress`, a last dotted IPv4 part counts as two
 * groups. None when any part is malformed.
 */
const parseGroups = (text: string, endsAddress: boolean): Option.Option<ReadonlyArray<number>> => {
	if (text === "") return Option.some([])
	const parts = Str.split(":")(text)
	return Option.all(
		Arr.map(parts, (part, index): Option.Option<ReadonlyArray<number>> => {
			if (HEX_GROUP.test(part)) return Option.some([Number.parseInt(part, 16)])
			if (!endsAddress || index !== parts.length - 1) return Option.none()
			return Option.map(ipv4Bytes(part), ([a = 0, b = 0, c = 0, d = 0]) => [a * 256 + b, c * 256 + d])
		}),
	).pipe(Option.map(Arr.flatten))
}

/** The eight 16-bit groups of an IPv6 address, or none when it does not parse as one. */
const ipv6Groups = (address: string): Option.Option<ReadonlyArray<number>> => {
	const halves = Str.split("::")(address)
	const [head, tail] = halves
	if (halves.length > 2) return Option.none()
	if (tail === undefined) return Option.filter(parseGroups(head, true), (groups) => groups.length === 8)
	return Option.flatMap(
		Option.all([parseGroups(head, false), parseGroups(tail, true)]),
		([left, right]) => {
			const missing = 8 - left.length - right.length
			return missing < 1
				? Option.none()
				: Option.some([...left, ...Arr.makeBy(missing, () => 0), ...right])
		},
	)
}

/**
 * The key a client is rate limited under: an IPv6 address by its /64, an IPv4 address (mapped into
 * IPv6 or not) in full. Anything that does not parse is used as it came.
 */
export const clientRateLimitKey = (address: string): string => {
	if (!Str.includes(":")(address)) return address
	return Option.match(ipv6Groups(address), {
		onNone: () => address,
		onSome: (groups) => {
			const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups
			// `::ffff:a.b.c.d` is an IPv4 client: its /64 would be shared by every IPv4 address.
			if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
				return `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`
			}
			return `${Arr.join(
				Arr.map([g0, g1, g2, g3], (group) => group.toString(16)),
				":",
			)}::/64`
		},
	})
}
