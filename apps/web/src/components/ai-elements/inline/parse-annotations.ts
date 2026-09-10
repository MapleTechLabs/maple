import type { Segment } from "./types";

type EntityType = "trace" | "service" | "error" | "log";

// The prompt asks for `<<maple:TYPE:JSON>>` on its own line, but models also
// drop them mid-sentence ("- <<maple:service:{…}>> — 50% failing") and
// occasionally with single brackets. Match all of those; where the annotation
// stands alone it becomes a card, and where it sits inside a line it becomes an
// inline label so the surrounding markdown (a bullet, a table cell) stays intact.
// Left to Streamdown, `<maple:service:{…}>` is a blocked HTML tag rendered as
// `<…[blocked]>`.
const ANNOTATION_RE = /<<?maple:(trace|service|error|log):(\{.*?\})>>?/g;

function inlineLabel(
  entityType: EntityType,
  data: Record<string, unknown>,
): string | undefined {
  switch (entityType) {
    case "service":
      return typeof data.name === "string" ? `**${data.name}**` : undefined;
    case "trace":
      return typeof data.id === "string" ? `\`${data.id}\`` : undefined;
    case "error":
      return typeof data.errorType === "string"
        ? `**${data.errorType}**`
        : undefined;
    case "log":
      return typeof data.body === "string" ? `\`${data.body}\`` : undefined;
  }
}

function isStandalone(text: string, start: number, end: number): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEndIndex = text.indexOf("\n", end);
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  return (
    text.slice(lineStart, start).trim() === "" &&
    text.slice(end, lineEnd).trim() === ""
  );
}

export function parseAnnotations(text: string): Segment[] {
  const segments: Segment[] = [];
  let pending = "";
  let lastIndex = 0;

  const flush = () => {
    if (pending) segments.push({ type: "text", content: pending });
    pending = "";
  };

  for (const match of text.matchAll(ANNOTATION_RE)) {
    const start = match.index!;
    const end = start + match[0].length;
    pending += text.slice(lastIndex, start);
    lastIndex = end;

    const entityType = match[1] as EntityType;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(match[2]);
    } catch {
      // Malformed annotations remain visible as text.
      pending += match[0];
      continue;
    }

    if (isStandalone(text, start, end)) {
      flush();
      segments.push({ type: entityType, data } as Segment);
      continue;
    }

    pending += inlineLabel(entityType, data) ?? match[0];
  }

  pending += text.slice(lastIndex);
  flush();

  if (segments.length === 0) {
    segments.push({ type: "text", content: text });
  }

  return segments;
}
