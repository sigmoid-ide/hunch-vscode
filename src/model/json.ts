/**
 * Reads and writes JSON the way Hunch's files hold it.
 *
 * Python's json module writes non-finite floats as the bare tokens NaN, Infinity
 * and -Infinity, which JSON.parse rejects, so this parser accepts them.
 */

export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };

export function parse(text: string): Json {
  const parser = new Parser(text);
  const value = parser.value();
  parser.skipWhitespace();
  if (!parser.atEnd()) parser.fail("unexpected text after the value");
  return value;
}

/** JSON on one line, with the line separators some readers split on escaped. */
export function write(value: unknown): string {
  return JSON.stringify(value).replace(/[\u2028\u2029\u0085]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? value : [];
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

class Parser {
  private i = 0;
  private readonly s: string;

  constructor(s: string) {
    this.s = s;
  }

  atEnd(): boolean {
    return this.i >= this.s.length;
  }

  fail(message: string): never {
    throw new SyntaxError(`invalid JSON at ${this.i}: ${message}`);
  }

  skipWhitespace(): void {
    while (this.i < this.s.length && " \t\n\r".includes(this.s[this.i])) this.i++;
  }

  value(): Json {
    this.skipWhitespace();
    if (this.atEnd()) this.fail("unexpected end");
    const c = this.s[this.i];
    switch (c) {
      case "{": return this.object();
      case "[": return this.array();
      case "\"": return this.string();
      case "t": return this.literal("true", true);
      case "f": return this.literal("false", false);
      case "n": return this.literal("null", null);
      case "N": return this.literal("NaN", NaN);
      case "I": return this.literal("Infinity", Infinity);
      default:
        if (this.s.startsWith("-Infinity", this.i)) return this.literal("-Infinity", -Infinity);
        return this.number();
    }
  }

  private literal(word: string, value: Json): Json {
    if (!this.s.startsWith(word, this.i)) this.fail(`expected ${word}`);
    this.i += word.length;
    return value;
  }

  private object(): JsonObject {
    const result: JsonObject = {};
    this.i++;
    this.skipWhitespace();
    if (this.s[this.i] === "}") {
      this.i++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.s[this.i] !== "\"") this.fail("expected a key");
      const key = this.string();
      this.skipWhitespace();
      if (this.s[this.i] !== ":") this.fail("expected ':'");
      this.i++;
      result[key] = this.value();
      this.skipWhitespace();
      const next = this.s[this.i++];
      if (next === "}") return result;
      if (next !== ",") this.fail("expected ',' or '}'");
    }
  }

  private array(): Json[] {
    const result: Json[] = [];
    this.i++;
    this.skipWhitespace();
    if (this.s[this.i] === "]") {
      this.i++;
      return result;
    }
    for (;;) {
      result.push(this.value());
      this.skipWhitespace();
      const next = this.s[this.i++];
      if (next === "]") return result;
      if (next !== ",") this.fail("expected ',' or ']'");
    }
  }

  private string(): string {
    let out = "";
    this.i++;
    for (;;) {
      if (this.atEnd()) this.fail("unterminated string");
      const c = this.s[this.i++];
      if (c === "\"") return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.s[this.i++];
      switch (e) {
        case "\"": out += "\""; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "u": {
          const hex = this.s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
          break;
        }
        default: this.fail(`unknown escape \\${e}`);
      }
    }
  }

  private number(): number {
    const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.s.slice(this.i, this.i + 64));
    if (!match) this.fail("expected a value");
    this.i += match[0].length;
    return Number(match[0]);
  }
}
