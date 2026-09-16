/**
 * EFX lexer, EXPRESSION mode.
 *
 * Transcribed from `grammar/EfxLexer.g4` (eForms SDK 1.15.1, CC BY 4.0).
 * Token names match the grammar's, so the two can be diffed by eye when the
 * SDK moves.
 *
 * The SDK lexer has three modes — DEFAULT, EXPRESSION and LABEL — because EFX
 * templates interleave free text, label references and expressions. This
 * package implements EXPRESSION mode only, which is what validation rules and
 * conditions are written in. Template and label lexing is out of scope and is
 * declared as such in `test/grammar-coverage.test.ts`.
 */

export type TokenKind =
  // punctuation
  | "OpenParenthesis" | "CloseParenthesis" | "OpenBracket" | "CloseBracket"
  | "Comma" | "ColonColon" | "SlashAt" | "Slash" | "Pipe"
  // operators
  | "Comparison" | "Star" | "Percent" | "Plus" | "Minus"
  // keywords
  | "And" | "Or" | "Not" | "Is" | "In" | "Like" | "Present" | "Empty"
  | "Unique" | "Every" | "Some" | "Satisfies" | "If" | "Then" | "Else"
  | "For" | "Return" | "Notice"
  | "Always" | "Never" | "True" | "False"
  // type casts
  | "TypeCast"
  // axes
  | "Axis"
  // functions
  | "Function"
  // literals and identifiers
  | "STRING" | "INTEGER" | "DECIMAL" | "DATE" | "TIME"
  | "DayTimeDurationLiteral" | "YearMonthDurationLiteral" | "UUIDV4"
  | "FieldId" | "NodeId" | "BtId" | "Variable" | "Identifier"
  | "EOF";

export interface Token {
  kind: TokenKind;
  /** Source text of the token. */
  text: string;
  /** For `TypeCast`, `Axis` and `Function`, the canonical keyword. */
  value?: string;
  start: number;
  end: number;
}

export class EfxSyntaxError extends Error {
  readonly position: number;
  readonly source: string;
  constructor(message: string, source: string, position: number) {
    super(`${message} at offset ${position}\n${caret(source, position)}`);
    this.name = "EfxSyntaxError";
    this.position = position;
    this.source = source;
  }
}

function caret(source: string, position: number): string {
  const from = Math.max(0, position - 40);
  const slice = source.slice(from, position + 40).replace(/\n/g, " ");
  return `  ${slice}\n  ${" ".repeat(position - from)}^`;
}

/** Type-cast keywords, longest first so `date:` cannot shadow nothing. */
const TYPE_CASTS = [
  "indicator:", "number:", "text:", "code:", "date:", "time:",
  "measure:", "context:",
] as const;

/** Axis names, longest first: `ancestor-or-self` must beat `ancestor`. */
const AXES = [
  "preceding-sibling", "following-sibling", "descendant-or-self",
  "ancestor-or-self", "descendant", "preceding", "following", "ancestor",
  "child",
] as const;

/** Function names, longest first for the same reason. */
const FUNCTIONS = [
  "year-month-duration", "day-time-duration", "distinct-values",
  "sequence-equal", "value-intersect", "subtract-measure", "format-number",
  "string-length", "value-except", "value-union", "add-measure",
  "starts-with", "ends-with", "substring", "contains", "concat", "string",
  "number", "count", "date", "time", "sum",
] as const;

/** Keywords that are not functions. Order matters only for prefixes. */
const KEYWORDS: Array<[string, TokenKind]> = [
  ["satisfies", "Satisfies"], ["present", "Present"], ["return", "Return"],
  ["unique", "Unique"], ["notice", "Notice"], ["every", "Every"],
  ["empty", "Empty"], ["then", "Then"], ["else", "Else"], ["like", "Like"],
  ["some", "Some"], ["and", "And"], ["not", "Not"], ["for", "For"],
  ["or", "Or"], ["is", "Is"], ["in", "In"], ["if", "If"],
  ["ALWAYS", "Always"], ["NEVER", "Never"], ["TRUE", "True"], ["FALSE", "False"],
];

const RE = {
  ws: /[ \t\r\n]+/y,
  date: /\d{4}-\d{2}-\d{2}(?:Z|[+-]\d{2}:\d{2})/y,
  time: /\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})/y,
  dayTime: /-?P\d+[WD]/y,
  yearMonth: /-?P\d+[YM]/y,
  uuid: /\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}/y,
  decimal: /-?\d*\.\d+/y,
  integer: /-?\d+/y,
  // FieldId: BtId ( '(' (BT-nnn | letter) ')' )? ('-' name)+
  fieldId: /(?:BT|OPP|OPT|OPA)-\d+(?:\((?:BT-\d+|[a-z])\))?(?:-[a-zA-Z_][a-zA-Z_0-9]*)+/y,
  btId: /(?:BT|OPP|OPT|OPA)-\d+/y,
  nodeId: /ND-[a-zA-Z0-9]+/y,
  variable: /\$[a-zA-Z][a-zA-Z0-9]*/y,
  identifier: /[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z][a-zA-Z0-9]*)*/y,
  colonColon: /[ \t]*::[ \t]*/y,
};

function match(re: RegExp, source: string, at: number): string | undefined {
  re.lastIndex = at;
  const m = re.exec(source);
  return m ? m[0] : undefined;
}

/** True when a word boundary follows, so `information` is not read as `in`. */
function wordBoundary(source: string, at: number): boolean {
  const c = source[at];
  return c === undefined || !/[a-zA-Z0-9_-]/.test(c);
}

/**
 * Tokenise an EFX expression.
 *
 * @throws {EfxSyntaxError} on an unrecognised character.
 */
export function tokenise(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;

  const push = (kind: TokenKind, text: string, value?: string) => {
    out.push(value === undefined
      ? { kind, text, start: i, end: i + text.length }
      : { kind, text, value, start: i, end: i + text.length });
    i += text.length;
  };

  while (i < source.length) {
    const ws = match(RE.ws, source, i);
    if (ws) { i += ws.length; continue; }

    const c = source[i] as string;

    // Two-character operators before one-character ones.
    const two = source.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === ">=" || two === "<=") {
      push("Comparison", two); continue;
    }
    if (two === "::") { push("ColonColon", match(RE.colonColon, source, i) ?? two); continue; }
    if (two === "/@") { push("SlashAt", two); continue; }

    // A leading minus belongs to a numeric or duration literal only when the
    // previous token cannot end an expression; otherwise it is subtraction.
    if (c === "-" && canStartLiteralHere(out)) {
      const dur = match(RE.dayTime, source, i) ?? match(RE.yearMonth, source, i);
      if (dur) { push(dur.includes("W") || dur.includes("D") ? "DayTimeDurationLiteral" : "YearMonthDurationLiteral", dur); continue; }
      const dec = match(RE.decimal, source, i);
      if (dec) { push("DECIMAL", dec); continue; }
      const int = match(RE.integer, source, i);
      if (int) { push("INTEGER", int); continue; }
    }

    switch (c) {
      case "(": push("OpenParenthesis", c); continue;
      case ")": push("CloseParenthesis", c); continue;
      case "[": push("OpenBracket", c); continue;
      case "]": push("CloseBracket", c); continue;
      case ",": push("Comma", c); continue;
      case "|": push("Pipe", c); continue;
      case "/": push("Slash", c); continue;
      case "*": push("Star", c); continue;
      case "%": push("Percent", c); continue;
      case "+": push("Plus", c); continue;
      case "-": push("Minus", c); continue;
      case ">": case "<": push("Comparison", c); continue;
      default: break;
    }

    if (c === '"' || c === "'") { push("STRING", readString(source, i, c)); continue; }

    const uuid = match(RE.uuid, source, i);
    if (uuid) { push("UUIDV4", uuid); continue; }

    const date = match(RE.date, source, i);
    if (date) { push("DATE", date); continue; }
    const time = match(RE.time, source, i);
    if (time) { push("TIME", time); continue; }

    if (c === "P") {
      const dt = match(RE.dayTime, source, i);
      if (dt) { push("DayTimeDurationLiteral", dt); continue; }
      const ym = match(RE.yearMonth, source, i);
      if (ym) { push("YearMonthDurationLiteral", ym); continue; }
    }

    if (/\d/.test(c) || c === ".") {
      const dec = match(RE.decimal, source, i);
      if (dec) { push("DECIMAL", dec); continue; }
      const int = match(RE.integer, source, i);
      if (int) { push("INTEGER", int); continue; }
    }

    if (c === "$") {
      const v = match(RE.variable, source, i);
      if (v) { push("Variable", v); continue; }
    }

    // Identifiers and keywords. Longest-match wins throughout.
    const cast = TYPE_CASTS.find((t) => source.startsWith(t, i));
    if (cast) { push("TypeCast", cast, cast.slice(0, -1)); continue; }

    const field = match(RE.fieldId, source, i);
    if (field) { push("FieldId", field); continue; }
    const node = match(RE.nodeId, source, i);
    if (node) { push("NodeId", node); continue; }
    const bt = match(RE.btId, source, i);
    if (bt) { push("BtId", bt); continue; }

    const axis = AXES.find((a) => source.startsWith(a, i) && source.startsWith("::", i + a.length));
    if (axis) { push("Axis", axis, axis); continue; }

    const fn = FUNCTIONS.find((f) => source.startsWith(f, i) && wordBoundary(source, i + f.length));
    if (fn) { push("Function", fn, fn); continue; }

    const kw = KEYWORDS.find(([w]) => source.startsWith(w, i) && wordBoundary(source, i + w.length));
    if (kw) { push(kw[1], kw[0]); continue; }

    const ident = match(RE.identifier, source, i);
    if (ident) { push("Identifier", ident); continue; }

    throw new EfxSyntaxError(`Unexpected character ${JSON.stringify(c)}`, source, i);
  }

  out.push({ kind: "EOF", text: "", start: i, end: i });
  return out;
}

/**
 * Whether a `-` at this point starts a literal rather than continuing a
 * subtraction. It does when nothing precedes it, or when the previous token
 * cannot end an operand.
 */
function canStartLiteralHere(tokens: Token[]): boolean {
  const prev = tokens[tokens.length - 1];
  if (!prev) return true;
  switch (prev.kind) {
    case "INTEGER": case "DECIMAL": case "STRING": case "DATE": case "TIME":
    case "DayTimeDurationLiteral": case "YearMonthDurationLiteral":
    case "FieldId": case "NodeId": case "BtId": case "Variable":
    case "Identifier": case "CloseParenthesis": case "CloseBracket":
      return false;
    default:
      return true;
  }
}

function readString(source: string, at: number, quote: string): string {
  let j = at + 1;
  while (j < source.length) {
    const ch = source[j];
    if (ch === "\\") { j += 2; continue; }
    if (ch === quote) return source.slice(at, j + 1);
    j++;
  }
  throw new EfxSyntaxError("Unterminated string literal", source, at);
}

/** Decode an EFX string literal to its value. */
export function stringLiteralValue(text: string): string {
  const body = text.slice(1, -1);
  return body.replace(/\\(.)/g, "$1");
}
