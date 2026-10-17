/** Fixture SQL splitter, preserving quoted semicolons and trigger bodies. */
export function splitSqlQuery(sql: string): string[] {
  const out: string[] = [];
  let current = "",
    quote = "",
    line = false,
    block = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i],
      next = sql[i + 1];
    if (line) {
      if (ch === "\n") {
        line = false;
        current += "\n";
      }
      continue;
    }
    if (block) {
      if (ch === "*" && next === "/") {
        block = false;
        i++;
      }
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else quote = "";
      }
      continue;
    }
    if (ch === "-" && next === "-") {
      line = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      block = true;
      i++;
      continue;
    }
    current += ch;
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (
      ch === ";" &&
      (!/^\s*CREATE\s+TRIGGER\b/i.test(current) ||
        /\bEND\s*;\s*$/i.test(current))
    ) {
      out.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
