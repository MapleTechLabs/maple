// Tiny highlighter for guide code blocks. The token classes match the colors a
// guide uses in its diagrams (metric name, labels, value), so a block reads the
// same way as the annotated example above it. Style the `tok-*` classes on the page.
export type GuideLang =
    | "exposition"
    | "promql"
    | "yaml"
    | "python"
    | "typescript"
    | "go"
    | "rust"
    | "java"
    | "csharp"
    | "json"
    | "python-logging"
    | "loguru-output";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (cls: string, text: string) => `<span class="tok-${cls}">${escape(text)}</span>`;

// Runs the first matching rule at each position; unmatched characters pass through.
const tokenize = (code: string, rules: Array<[RegExp, (m: RegExpExecArray) => string]>) => {
    let out = "";
    let i = 0;
    while (i < code.length) {
        let matched = false;
        for (const [re, render] of rules) {
            re.lastIndex = i;
            const m = re.exec(code);
            if (m && m.index === i && m[0].length > 0) {
                out += render(m);
                i += m[0].length;
                matched = true;
                break;
            }
        }
        if (!matched) {
            out += escape(code[i]);
            i += 1;
        }
    }
    return out;
};

const promqlFunctions =
    /\b(?:rate|irate|increase|sum|avg|min|max|count|topk|bottomk|histogram_quantile|max_over_time|min_over_time|avg_over_time|predict_linear|by|without|on|ignoring)\b/y;

const promql = (code: string) =>
    tokenize(code, [
        [/#.*/y, (m) => span("comment", m[0])],
        [/\{[^}\n]*\}/y, (m) => span("labels", m[0])],
        [/\[[^\]\n]+\]/y, (m) => span("value", m[0])],
        // The label list after by/without is labels, not metric names.
        [/\b(by|without)(\s*)(\([^)\n]*\))/y, (m) => span("fn", m[1]) + m[2] + span("labels", m[3])],
        [promqlFunctions, (m) => span("fn", m[0])],
        [/\b\d+(?:\.\d+)?\b/y, (m) => span("value", m[0])],
        [/[a-zA-Z_:][\w:]*/y, (m) => span("name", m[0])],
    ]);

const exposition = (code: string) =>
    code
        .split("\n")
        .map((line) => {
            const meta = /^(# (?:HELP|TYPE) )(\S+)(.*)$/.exec(line);
            if (meta) return span("comment", meta[1]) + span("name", meta[2]) + span("comment", meta[3]);
            const sample = /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?(\s+)(\S+)(.*)$/.exec(line);
            if (sample) {
                return span("name", sample[1]) + (sample[2] ? span("labels", sample[2]) : "") + sample[3] + span("value", sample[4]) + escape(sample[5]);
            }
            return escape(line);
        })
        .join("\n");

const yaml = (code: string) =>
    tokenize(code, [
        [/#.*/y, (m) => span("comment", m[0])],
        [/(?<=^|\n)(\s*-?\s*)([\w./-]+)(:)/y, (m) => escape(m[1]) + span("name", m[2]) + escape(m[3])],
        [/"[^"\n]*"/y, (m) => span("labels", m[0])],
        [/\b\d+[a-z]*\b/y, (m) => span("value", m[0])],
    ]);

const python = (code: string) =>
    tokenize(code, [
        [/#.*/y, (m) => span("comment", m[0])],
        [/"[^"\n]*"/y, (m) => span("labels", m[0])],
        [/\b(?:from|import|def|with|as|return)\b/y, (m) => span("fn", m[0])],
        [/\b(?:Counter|Gauge|Histogram|Summary)\b/y, (m) => span("name", m[0])],
        [/\b\d+(?:\.\d+)?\b/y, (m) => span("value", m[0])],
        [/[a-zA-Z_]\w*/y, (m) => escape(m[0])],
    ]);

// Brace languages share one tokenizer: comments, strings, keywords, the metric
// classes (orange, like metric names), numbers.
const braces = (keywords: string) => {
    const keywordRe = new RegExp(`\\b(?:${keywords})\\b`, "y");
    return (code: string) =>
        tokenize(code, [
            [/\/\/.*/y, (m) => span("comment", m[0])],
            [/"[^"\n]*"/y, (m) => span("labels", m[0])],
            [keywordRe, (m) => span("fn", m[0])],
            [/\b(?:Counter|CounterVec|Histogram|HistogramOpts|CounterOpts|Metrics)\b/y, (m) => span("name", m[0])],
            [/\b\d+(?:\.\d+)?\b/y, (m) => span("value", m[0])],
            [/[a-zA-Z_]\w*/y, (m) => escape(m[0])],
        ]);
};

const typescript = braces("import|from|const|let|new|async|await|return|if");
const go = braces("package|import|var|func|defer|return|if");
const rust = braces("use|fn|let|mut|for|in");
const java = braces("import|public|static|final|class|void|new|try|throws");
const csharp = braces("using|var|new|await");

// JSON and NDJSON log lines. OpenTelemetry's trace-context fields get their own
// class so a guide can color them like the traces in its diagrams.
const json = (code: string) =>
    tokenize(code, [
        [/"(?:trace_id|span_id|trace_flags)":\s*"[^"\n]*"/y, (m) => span("trace", m[0])],
        [/"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, (m) => span("name", m[0])],
        [/"(?:[^"\\\n]|\\.)*"/y, (m) => span("labels", m[0])],
        [/-?\b\d+(?:\.\d+)?\b|\b(?:true|false|null)\b/y, (m) => span("value", m[0])],
    ]);

// Python logging code. Loguru, the standard logging module and the OpenTelemetry
// SDK each get a class, so a guide can color them like the systems in its diagrams.
const pythonLogging = (code: string) =>
    tokenize(code, [
        [/#.*/y, (m) => span("comment", m[0])],
        [/"[^"\n]*"|'[^'\n]*'/y, (m) => span("labels", m[0])],
        [/\b(?:from|import|def|class|with|as|return|try|except|if|else|for|while|in|not|is|and|or|None|True|False|lambda|global|async|await|raise)\b/y, (m) => span("fn", m[0])],
        [/\b(?:loguru|logger)\b/y, (m) => span("loguru", m[0])],
        [/\b(?:logging|LogRecord|Handler|getLogger|basicConfig|makeRecord)\b/y, (m) => span("stdlib", m[0])],
        [/\b(?:opentelemetry|LoggingHandler|LoggerProvider|logger_provider|set_logger_provider|trace|tracer|BatchLogRecordProcessor|SimpleLogRecordProcessor|OTLPLogExporter|ConsoleLogRecordExporter)\b/y, (m) => span("otel", m[0])],
        [/\b\d+(?:\.\d+)?\b/y, (m) => span("value", m[0])],
        [/[a-zA-Z_]\w*/y, (m) => escape(m[0])],
    ]);

// Loguru's default console line: time | LEVEL | location - message. Each level
// gets its own class (tok-level-info, tok-level-error...); traceback lines pass through.
const loguruOutput = (code: string) =>
    code
        .split("\n")
        .map((line) => {
            const entry = /^([\d-]+ [\d:.]+|[\d:]+)( \| )([A-Z]+)(\s*)( \| )(.*)$/.exec(line);
            if (entry) {
                const [, time, sep1, level, pad, sep2, rest] = entry;
                const location = /^(\S+ - )(.*)$/.exec(rest);
                return (
                    span("comment", time) +
                    span("comment", sep1) +
                    span(`level-${level.toLowerCase()}`, level) +
                    pad +
                    span("comment", sep2) +
                    (location ? span("comment", location[1]) + escape(location[2]) : escape(rest))
                );
            }
            const error = /^(\w+(?:Error|Exception)):(.*)$/.exec(line);
            if (error) return span("level-error", error[1]) + escape(":" + error[2]);
            return /^\s*[│└]/.test(line) ? span("comment", line) : escape(line);
        })
        .join("\n");

export const highlight = (code: string, lang: GuideLang) =>
    ({
        exposition,
        promql,
        yaml,
        python,
        typescript,
        go,
        rust,
        java,
        csharp,
        json,
        "python-logging": pythonLogging,
        "loguru-output": loguruOutput,
    })[lang](code);
