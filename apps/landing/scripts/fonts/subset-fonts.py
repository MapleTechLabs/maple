#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["fonttools[woff]==4.60.2", "uharfbuzz==0.57.0"]
# ///
"""Cut Geist and Geist Mono down to what the landing site renders.

Run by hand from apps/landing, commit the output:

    bun run build && ./scripts/fonts/subset-fonts.py
    bun run build && ./scripts/fonts/subset-fonts.py --check   # stale? exit 1

It reads the built site in dist/ for the characters in use, downloads the
pinned upstream fonts, and writes per family a preloaded core file and an
extended file behind `unicode-range` (plus a box-drawing file for Geist Mono),
into src/fonts/, and the @font-face rules in src/styles/fonts.generated.css.
The build itself does no font work.

Rerun (`--check` tells you) when:
  - content gains a character Geist already drew that the files lack, e.g.
    a new symbol or box-drawing character;
  - a page starts using a weight outside WGHT, or turns on an OpenType feature
    not in FEATURES (`font-variant-numeric`, `font-feature-settings`, ...);
  - the source fonts are bumped (update SOURCES and the sha256s).

Rendering must stay identical, so the script checks its own output: every
kept glyph has the same outline and advance as the source at each weight the
site uses, and every text run in dist/ shapes to the same positions across
the file split as with the whole font. It exits non-zero otherwise. The one
that will trip first is kerning across the split: text like "Té" or "café"
puts the accented letter in another file, and the pair kern is lost. Move the
letter into CORE, or accept the change.
"""

from __future__ import annotations

import hashlib
import html.parser
import io
import itertools
import re
import subprocess
import sys
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import uharfbuzz as hb
from fontTools import subset
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

LANDING = Path(__file__).resolve().parents[2]
DIST = LANDING / "dist"
OUT_FONTS = LANDING / "src" / "fonts"
OUT_CSS = LANDING / "src" / "styles" / "fonts.generated.css"
CACHE = LANDING / "node_modules" / ".cache" / "landing-fonts"


@dataclass(frozen=True)
class Source:
    url: str
    sha256: str


# Same builds the @fontsource-variable 5.3.0 files were cut from (Geist 1.800,
# Geist Mono 1.701): glyph outlines, deltas and advances match those files.
SOURCES = {
    "geist": Source(
        "https://raw.githubusercontent.com/google/fonts/87a44ad3d4535f7b3a5a715a08e8944f144afd06/ofl/geist/Geist%5Bwght%5D.ttf",
        "73894e0448cae90a92b6c2f8732b7bb9acb7b94c418bff559dad4a18e1de9659",
    ),
    "geist-mono": Source(
        "https://raw.githubusercontent.com/google/fonts/9e25e2ba265e5298f70f6182dd4e8a3ebf1b9123/ofl/geistmono/GeistMono%5Bwght%5D.ttf",
        "d00e590b8eb3a59acc329b2d044fd143ae935090b7da33199ebee27cc7de8196",
    ),
}


def ranges(spec: str) -> frozenset[int]:
    out: set[int] = set()
    for part in spec.replace("U+", "").split(","):
        lo, _, hi = part.strip().partition("-")
        out.update(range(int(lo, 16), int(hi or lo, 16) + 1))
    return frozenset(out)


# What each family drew before this script existed: the union of the
# @fontsource-variable 5.3.0 faces' unicode-ranges, intersected with the glyphs
# those files carry. Anything else (→, ⌘, ✓, CJK) has always come from a system
# font. Keeping it that way is what keeps rendering identical, so a character
# outside this set is never added, even when Geist has a glyph for it.
_COMMON = (
    "U+0020-007E,U+00A0-00AC,U+00AE-0113,U+0116-012B,U+012E-0131,U+0134-0137,U+0139-013E,"
    "U+0141-0148,U+014A-014D,U+0150-017E,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01CD-01CE,"
    "U+01E4-01E9,U+0218-021B,U+0237,U+0259,U+02B9,U+02BC,U+02C6-02C8,U+02DA,U+02DC-02DD,"
    "U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0400-045F,U+0462-0463,U+046A-046B,"
    "U+0472-0475,U+0490-0493,U+0496-0497,U+049A-049B,U+04A2-04A3,U+04AE-04B3,U+04B6-04B7,"
    "U+04BA-04BB,U+04C0,U+04CF,U+04D8-04D9,U+04E2-04E3,U+04E8-04E9,U+04EE-04EF,U+1E20-1E21,"
    "U+1E80-1E85,U+1E9E,U+1EA0-1EF9,U+2013-2014,U+2018-201A,U+201C-201E,U+2020,U+2022,U+2026,"
    "U+2032-2033,U+2039-203A,U+2044,U+20AA,U+20AC,U+20B1,U+20B4,U+20B9,U+20BD,U+2116,U+2122,"
    "U+2191,U+2193,U+2212,U+A78B-A78C"
)
# Geist Mono lacks U+0132-0133; Geist lacks U+2500-259F (Mono's symbols2 face).
DRAWN_TODAY = {
    "geist": ranges(_COMMON) | ranges("U+0132-0133"),
    "geist-mono": ranges(_COMMON) | ranges("U+2500-259F"),
}

# ASCII and the punctuation most pages use. `…` also has to be here for
# `text-overflow: ellipsis`, which draws it without it being in the text.
# `©` and `·` sit in the footer and nav of every page.
CORE = ranges("U+0020-007E") | {0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x00A9, 0x00B7}

# The old faces' unicode-ranges also listed characters their files had no
# glyph for, and browsers still drew them from that face. Chromium drew U+2011
# (in the pricing headline) as Geist's own hyphen; WebKit picks the face for a
# tab, a newline collapsed to a space, or a zero-width space by the original
# character, then draws it with that face's space. The core maps them to those
# glyphs rather than handing them to a system font.
ALIASES = {0x2011: 0x002D, 0x0009: 0x0020, 0x000A: 0x0020, 0x200B: 0x0020}

LATIN_1_AND_EXT_A = ranges("U+00A0-017F")

# Chromium on macOS looks up the glyphs named `X` and `o` in each font file,
# and whether they are there changes how every glyph in that file is
# antialiased at text sizes (seen at 14-16px, gone by 22px). fontsource's latin
# file had both, so the extended file carries an unencoded `X` (it already has
# `o` as a component of ò ó ô). Its symbols2 file had neither, so Geist Mono's
# box drawing gets a file of its own without them.
EXT_GLYPHS = ("X", "o")
BOX_DRAWING = ranges("U+2500-259F")

# WebKit picks the face for a no-break space by its unicode-range, then draws
# it with that face's U+0020. Without one it borrows a system font's space,
# narrower and with other line metrics. The non-core files carry U+0020 for
# that, encoded but left out of their unicode-range so the core still owns it.
UNLISTED = {0x0020}

# Default-on features plus `tnum` (Tailwind `tabular-nums`, the only feature
# the site turns on). Dropped: frac/numr/dnom and pnum (never enabled), locl
# (only AZE/CAT/NLD/ROM/TRK-style language systems; pages are en/ja/ko).
FEATURES = ["ccmp", "kern", "liga", "mark", "mkmk", "tnum"]

# Weights in use, from a computed-style audit of every page: Geist 400, 430,
# 500, 550, 600, 650, 700, 750; Geist Mono 400, 430, 500, 550, 600, 700. Both
# fonts are two masters, 100 and 900, around a 400 default. Starting the axis
# at 400 drops the 100 master outright. The top stays at 900: cutting it to
# 750/700 removes no master, saves almost nothing, and rescales every delta,
# which rounds outlines off by up to half a unit.
WGHT = {"geist": (400, 900), "geist-mono": (400, 900)}
CHECK_WEIGHTS = {"geist": (400, 430, 500, 550, 600, 650, 700, 750, 900), "geist-mono": (400, 430, 500, 550, 600, 700, 900)}


@dataclass(frozen=True)
class Family:
    slug: str
    css_family: str


FAMILIES = (Family("geist", "Geist Variable"), Family("geist-mono", "Geist Mono Variable"))


def fetch(slug: str) -> bytes:
    src = SOURCES[slug]
    path = CACHE / f"{slug}-{src.sha256[:12]}.ttf"
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(src.url) as res:
            path.write_bytes(res.read())
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != src.sha256:
        path.unlink()
        sys.exit(f"{slug}: sha256 mismatch for {src.url}")
    return data


class TextCollector(html.parser.HTMLParser):
    """Text content of a page, minus scripts and styles, plus input text."""

    SKIP = {"script", "style", "template"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.runs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.SKIP:
            self.depth += 1
        for name, value in attrs:
            if value and name in ("placeholder", "value"):
                self.runs.append(value)

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP and self.depth:
            self.depth -= 1

    def handle_data(self, data: str) -> None:
        if not self.depth and data.strip():
            self.runs.append(data)


ESCAPE = re.compile(r"\\u\{?([0-9a-fA-F]{4,6})\}?")


def content() -> tuple[set[int], list[str]]:
    """Every codepoint in dist/, and the HTML text runs for the shaping check.

    Scripts count too, for text the islands render on the client. That reaches
    library strings as well, but only characters a family drew already can get
    in, so the cost is a few glyphs at most.
    """
    if not (DIST / "index.html").exists():
        sys.exit("dist/ is missing: run `bun run build` first")
    cps: set[int] = set()
    runs: list[str] = []
    for page in sorted(DIST.rglob("*.html")):
        parser = TextCollector()
        parser.feed(page.read_text("utf-8"))
        runs.extend(parser.runs)
    for path in [*DIST.rglob("*.js"), *DIST.rglob("*.css")]:
        text = path.read_text("utf-8", errors="ignore")
        cps.update(ord(c) for c in text)
        cps.update(int(m, 16) for m in ESCAPE.findall(text))
    for run in runs:
        cps.update(ord(c) for c in run)
    # text-transform can draw the other case.
    for cp in list(cps):
        for c in (chr(cp).upper(), chr(cp).lower()):
            if len(c) == 1:
                cps.add(ord(c))
    return cps, list(dict.fromkeys(runs))


def check_license(font: TTFont, slug: str) -> None:
    for name_id in (0, 13):
        text = font["name"].getDebugName(name_id) or ""
        if "reserved font name" in text.lower():
            sys.exit(f"{slug}: declares a Reserved Font Name; subsets must be renamed before shipping")


def build(source: bytes, unicodes: set[int], wght: tuple[int, int], glyphs: tuple[str, ...] = ()) -> TTFont:
    font = TTFont(io.BytesIO(source), recalcTimestamp=False)
    options = subset.Options()
    options.layout_features = FEATURES
    # The only "hinting" here is gftools' unhinted-font fix (a 7-byte prep and
    # a gasp table); no glyph has instructions. Windows uses them for
    # smoothing, so they stay.
    options.hinting = True
    options.drop_tables += ["meta"]
    # Chromium on macOS antialiases small text differently when the post table
    # has no glyph names, or different ones (seen at 16px, not at 28px). The
    # names cost ~0.5 KB a file and are what keeps the pixels identical.
    options.glyph_names = True
    options.recalc_timestamp = False
    # Otherwise `›` pulls in `‹` and `«` pulls in `»`, for right-to-left
    # mirroring that no page here needs.
    options.bidi_closure = False
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=unicodes, glyphs=glyphs)
    subsetter.subset(font)
    for table in font["cmap"].tables:
        # Extra glyphs come back encoded; they stay in the file, not the cmap.
        table.cmap = {cp: glyph for cp, glyph in table.cmap.items() if cp in unicodes}
        for alias, target in ALIASES.items():
            if alias in unicodes and target in table.cmap:
                table.cmap[alias] = table.cmap[target]
    # The instancer bakes the deltas the source leaves to interpolation (IUP)
    # into rounded integers, moving points by a fraction of a unit. The default
    # stays at 400, so the upper master's normalized coordinates don't change:
    # put its original tuples back and only drop the ones below the default.
    tuples = {glyph: list(variations) for glyph, variations in font["gvar"].variations.items()}
    font = instancer.instantiateVariableFont(font, {"wght": wght}, optimize=False)
    if wght[0] != 400:
        sys.exit("restoring gvar tuples assumes the axis keeps its 400 default")
    font["gvar"].variations = {
        glyph: [v for v in variations if v.axes["wght"][1] > 0] for glyph, variations in tuples.items()
    }
    # Keep the full font's bounding box, as the fontsource files did: a box
    # recomputed from the kept glyphs also shifts antialiasing on macOS.
    source_head = TTFont(io.BytesIO(source))["head"]
    for key in ("xMin", "yMin", "xMax", "yMax"):
        setattr(font["head"], key, getattr(source_head, key))
    font.recalcBBoxes = False
    font.flavor = "woff2"
    return font


def reload(font: TTFont) -> tuple[TTFont, bytes, bytes]:
    """The font as written, its WOFF2 bytes, and the plain sfnt that HarfBuzz
    can read (it treats WOFF2 bytes as an empty face)."""
    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()
    written = TTFont(io.BytesIO(data), recalcTimestamp=False, recalcBBoxes=False)
    sfnt = io.BytesIO()
    written.flavor = None
    written.save(sfnt)
    return TTFont(io.BytesIO(data), recalcTimestamp=False, recalcBBoxes=False), data, sfnt.getvalue()


def unicode_range(cps: set[int]) -> str:
    cps_sorted, out, i = sorted(cps), [], 0
    while i < len(cps_sorted):
        j = i
        while j + 1 < len(cps_sorted) and cps_sorted[j + 1] == cps_sorted[j] + 1:
            j += 1
        lo, hi = cps_sorted[i], cps_sorted[j]
        out.append(f"U+{lo:04X}" if lo == hi else f"U+{lo:04X}-{hi:04X}")
        i = j + 1
    return ",".join(out)


def outlines(font: TTFont, weight: int, cps: set[int]) -> dict[int, tuple]:
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet(location={"wght": weight}, normalized=False)
    out = {}
    for cp in cps:
        glyph = glyphs[cmap.get(cp) or cmap[ALIASES[cp]]]
        pen = DecomposingRecordingPen(glyphs)
        glyph.draw(pen)
        out[cp] = (glyph.width, tuple(pen.value))
    return out


class Shaper:
    def __init__(self, data: bytes) -> None:
        self.face = hb.Face(data)
        self.fonts: dict[int, hb.Font] = {}

    def __call__(self, text: str, weight: int, features: dict[str, bool]) -> list[tuple[int, int, int, int]]:
        if weight not in self.fonts:
            self.fonts[weight] = hb.Font(self.face)
            self.fonts[weight].set_variations({"wght": weight})
        buf = hb.Buffer()
        buf.add_codepoints([ord(c) for c in text])
        buf.guess_segment_properties()
        hb.shape(self.fonts[weight], buf, features)
        return [(i.cluster, p.x_advance, p.x_offset, p.y_offset) for i, p in zip(buf.glyph_infos, buf.glyph_positions)]


def check_shaping(source: bytes, files: list[tuple[bytes, set[int]]], runs: list[str], slug: str) -> tuple[list[str], int]:
    """Shape each text run as the browser does, split by which file covers each
    character, and compare it with the source font shaping the same run whole.

    Characters no file has come from a fallback font before and after, so they
    end a run. Returns the differing runs and how many runs were checked."""
    shape_source = Shaper(source)
    shapers = [(Shaper(data), cps) for data, cps in files]
    owner = {cp: shaper for shaper, cps in shapers for cp in cps}
    # Browsers collapse tabs and newlines to spaces, and HarfBuzz hides a
    # zero-width space whether or not the font maps it: only U+2011 shapes as
    # its alias.
    collapsed = (re.sub(r"[\t\n]+", " ", run) for run in runs)
    pieces = {p for run in collapsed for p in re.split(f"[^{''.join(re.escape(chr(c)) for c in sorted(owner))}]+", run) if p.strip()}
    problems = []
    for piece in sorted(pieces):
        segments = ["".join(g) for _, g in itertools.groupby(piece, lambda c: id(owner[ord(c)]))]
        for weight in (400, 600):
            for features in ({}, {"tnum": True}):
                want = shape_source(piece.translate({0x2011: 0x002D}), weight, features)
                got, offset = [], 0
                for seg in segments:
                    got += [(c + offset, *rest) for c, *rest in owner[ord(seg[0])](seg, weight, features)]
                    offset += len(seg)
                if want != got:
                    problems.append(f"{slug} wght {weight} {features or ''}: {piece.strip()[:80]!r}")
    return problems, len(pieces)


def formatted(css: str) -> str:
    """The CSS as the repo's oxfmt leaves it, so a rerun is not a diff."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "fonts.css"
        path.write_text(css)
        subprocess.run([LANDING.parents[1] / "node_modules" / ".bin" / "oxfmt", path], check=True, capture_output=True)
        return path.read_text()


def main() -> None:
    check = "--check" in sys.argv[1:]
    outputs: dict[Path, bytes] = {}
    used, runs = content()
    css = [
        "/* Generated by scripts/fonts/subset-fonts.py. Do not edit; rerun the script.",
        "   Core files hold ASCII and common punctuation and are preloaded (FontPreloads.astro);",
        "   the others only download on pages that use one of their characters. `no-inline`",
        "   keeps Vite from inlining a small file into the CSS every page loads. */",
    ]
    failures: list[str] = []
    OUT_FONTS.mkdir(parents=True, exist_ok=True)
    for family in FAMILIES:
        source = fetch(family.slug)
        src_font = TTFont(io.BytesIO(source))
        check_license(src_font, family.slug)
        has = set(src_font.getBestCmap()) & DRAWN_TODAY[family.slug]
        core_cps = (CORE & has) | {alias for alias, target in ALIASES.items() if target in CORE & has}
        box_cps = BOX_DRAWING & used & has
        ext_cps = ((LATIN_1_AND_EXT_A | used) & has) - core_cps - box_cps
        parts = [("core", core_cps, ()), ("ext", ext_cps, EXT_GLYPHS), ("box", box_cps, ())]

        files = {}
        for part, cps, glyphs in (p for p in parts if p[1]):
            unlisted = UNLISTED - cps if part != "core" else set()
            font, data, sfnt = reload(build(source, cps | unlisted, WGHT[family.slug], glyphs))
            got = set(font.getBestCmap())
            if got != cps | unlisted:
                failures.append(f"{family.slug}-{part}: cmap differs from plan: {sorted(got ^ (cps | unlisted))}")
            got -= unlisted
            has_context = [g in font.getGlyphOrder() for g in EXT_GLYPHS]
            if has_context != [part != "box"] * len(EXT_GLYPHS):
                failures.append(f"{family.slug}-{part}: glyphs {EXT_GLYPHS} present: {has_context}")
            if font["post"].formatType != 2.0 or font.getGlyphOrder() != [g for g in src_font.getGlyphOrder() if g in set(font.getGlyphOrder())]:
                failures.append(f"{family.slug}-{part}: glyph names were not kept")
            if [getattr(font["head"], k) for k in ("xMin", "yMin", "xMax", "yMax")] != [getattr(src_font["head"], k) for k in ("xMin", "yMin", "xMax", "yMax")]:
                failures.append(f"{family.slug}-{part}: head bounding box differs from the source")
            axis = next(a for a in font["fvar"].axes if a.axisTag == "wght")
            if (axis.minValue, axis.maxValue) != WGHT[family.slug]:
                failures.append(f"{family.slug}-{part}: wght axis is {axis.minValue}-{axis.maxValue}")
            for weight in CHECK_WEIGHTS[family.slug]:
                if outlines(font, weight, got) != outlines(src_font, weight, got):
                    failures.append(f"{family.slug}-{part}: outlines or advances differ from the source at wght {weight}")
            path = OUT_FONTS / f"{family.slug}-{part}.woff2"
            outputs[path] = data
            files[part] = (sfnt, got)
            features = sorted({r.FeatureTag for t in ("GSUB", "GPOS") if t in font for r in font[t].table.FeatureList.FeatureRecord})
            print(f"{path.relative_to(LANDING)}: {len(data):,} B, {len(got)} codepoints, {font['maxp'].numGlyphs} glyphs, features {' '.join(features)}, tables {' '.join(sorted(font.keys()))}")
            css += [
                "",
                "@font-face {",
                f'\tfont-family: "{family.css_family}";',
                "\tfont-style: normal;",
                "\tfont-display: swap;",
                f"\tfont-weight: {WGHT[family.slug][0]} {WGHT[family.slug][1]};",
                f'\tsrc: url("../fonts/{path.name}?no-inline") format("woff2-variations");',
                f"\tunicode-range: {unicode_range(got)};",
                "}",
            ]
        problems, checked = check_shaping(source, list(files.values()), runs, family.slug)
        print(f"  {family.slug}: {checked:,} text runs shaped, {len(problems)} differ from the source font")
        failures += problems

        skipped = sorted(cp for cp in used & set(src_font.getBestCmap()) if cp not in DRAWN_TODAY[family.slug] and cp > 0x7E)
        if skipped:
            print(f"  {family.slug}: has glyphs for, but never drew, {' '.join(chr(c) for c in skipped)} (left to fallback fonts)")

    outputs[OUT_CSS] = formatted("\n".join(css) + "\n").encode()
    committed = {p for p in OUT_FONTS.glob("*.woff2")} | {OUT_CSS}
    if check:
        stale = sorted(str(p.relative_to(LANDING)) for p in committed | set(outputs) if not p.exists() or p not in outputs or p.read_bytes() != outputs[p])
        print("committed fonts are current" if not stale else f"stale, rerun without --check: {' '.join(stale)}")
        failures += [f"stale: {p}" for p in stale]
    else:
        for path in committed - set(outputs):
            path.unlink()
        for path, data in outputs.items():
            path.write_bytes(data)
        print(f"wrote {len(outputs)} files")
    if failures:
        print("\nFAILED:", *failures[:40], sep="\n  ")
        if len(failures) > 40:
            print(f"  ... and {len(failures) - 40} more")
        sys.exit(1)


if __name__ == "__main__":
    main()
