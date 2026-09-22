/** Deterministic name handling shared by extraction, clustering and existing-company matching. */

export function asciiFold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

const TLD_SUFFIX = /\.(ai|com|io|co|app|dev|xyz|tech|so|ly|me|org|net|eu|health|bio|space|cloud)$/i;
const LEGAL = new Set(["inc", "llc", "ltd", "limited", "gmbh", "ab", "ag", "sas", "sa", "corp", "corporation", "company", "co", "plc", "bv", "oy", "as", "pty", "srl", "spa", "nv", "kk", "gbr", "ug"]);
const GENERIC_TAIL = new Set(["ai", "labs", "lab", "technologies", "technology", "tech", "group", "hq", "io", "software", "systems", "robotics", "security", "health", "bio", "cloud", "app", "apps", "platform", "energy", "power", "solutions", "therapeutics", "pharma", "medical", "finance", "studio", "studios", "digital", "networks", "analytics", "bioscience", "biosciences", "materials", "mobility"]);

/** If the name is itself a domain ("Fin.com", "Empirik.ai"), that domain; otherwise null. */
export function domainInName(name: string): string | null {
  const t = name.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.(ai|com|io|co|app|dev|xyz|tech|so|ly|me|org|net|eu|space|cloud)$/.test(t) ? t : null;
}

function tokens(name: string): string[] {
  const base = asciiFold(name).toLowerCase().replace(TLD_SUFFIX, "");
  const t = base.split(/[^a-z0-9]+/).filter(Boolean);
  while (t.length > 1 && LEGAL.has(t[t.length - 1] as string)) t.pop();
  return t;
}

/** Compact comparison key: "Empirik.ai" -> "empirik", "Gaia Dynamics" -> "gaiadynamics", "Project-S" -> "projects". */
export function nameKey(name: string): string {
  return tokens(name).join("");
}

/** Key with generic trailing words removed ("TypeSafe AI" -> "typesafe"); equals nameKey when nothing generic trails. */
export function aliasKey(name: string): string {
  const t = tokens(name);
  while (t.length > 1 && GENERIC_TAIL.has(t[t.length - 1] as string)) t.pop();
  return t.join("");
}

/** Normalized Levenshtein similarity of two compact strings, 0..1. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - (prev[n] as number) / Math.max(m, n);
}

const LEADING_VERBISH = /^(use|get|try|go|join|meet|hello|the|my|with)/;

/**
 * How well a candidate domain matches a company name (keys). 1 = the domain's first label IS the name; 0.95 = it is the
 * name behind a marketing prefix ("useaiir" for "aiir"); 0.85 = one contains the other; otherwise edit similarity.
 */
export function nameDomainSimilarity(keys: readonly string[], domain: string): number {
  const label = domain.split(".")[0]?.replace(/-/g, "") ?? "";
  if (!label) return 0;
  let best = 0;
  for (const key of keys) {
    if (!key) continue;
    if (label === key) return 1;
    const stripped = label.replace(LEADING_VERBISH, "");
    if (stripped.length >= 3 && stripped === key) best = Math.max(best, 0.95);
    else if (Math.min(label.length, key.length) >= 4 && (label.includes(key) || key.includes(label))) best = Math.max(best, 0.85);
    else best = Math.max(best, similarity(label, key) * 0.9);
  }
  return best;
}
