// Browser-safe .env parser and serializer following dotenv v16 rules.
// One deliberate extension: inside double quotes, \" and \\ are unescaped too,
// so that serializeDotenv output always round-trips.

export interface DotenvEntry {
  key: string;
  value: string;
}

const LINE =
  /(?:^|^)\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\[\s\S]|[^"\\])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

export function parseDotenv(text: string): DotenvEntry[] {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const order: string[] = [];
  const values = new Map<string, string>();
  LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINE.exec(lines)) !== null) {
    if (match[0].length === 0) {
      LINE.lastIndex++;
      continue;
    }
    const key = match[1];
    if (key === undefined) continue;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/, "$2");
    if (quote === '"') {
      value = value.replace(/\\([nr"\\])/g, (_m, c: string) =>
        c === "n" ? "\n" : c === "r" ? "\r" : c,
      );
    }
    if (!values.has(key)) order.push(key);
    values.set(key, value);
  }
  return order.map((key) => ({ key, value: values.get(key) as string }));
}

export function toRecord(entries: DotenvEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) out[e.key] = e.value;
  return out;
}

function needsQuotes(value: string): boolean {
  if (value === "") return false;
  return /[\r\n#'"`\\]/.test(value) || value !== value.trim();
}

export function serializeDotenv(entries: DotenvEntry[]): string {
  let out = "";
  for (const { key, value } of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      throw new Error(`Invalid .env key: ${JSON.stringify(key)}`);
    }
    if (needsQuotes(value)) {
      const esc = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n");
      out += `${key}="${esc}"\n`;
    } else {
      out += `${key}=${value}\n`;
    }
  }
  return out;
}
