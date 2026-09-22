/**
 * Deterministic job-title classification. NO LLM — this is regex/keyword matching only, exactly
 * like the V2-1 funnel's own extract.ts/prefilter.ts. Rules are intentionally conservative: a
 * vague or ambiguous title falls into "other" rather than being guessed into a category.
 */
export const ROLE_CATEGORIES = [
  "engineering", "product", "design", "sales", "marketing", "customer_success", "operations",
  "finance", "legal", "people_recruiting", "security", "executive_leadership", "other",
] as const;
export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

interface Rule {
  category: RoleCategory;
  pattern: RegExp;
}

// Order matters: first match wins. More specific/senior patterns are checked before generic ones
// so e.g. "Chief Security Officer" lands in executive_leadership (a company's top security hire is
// as much a leadership signal as a security one — see the V2-2A report for this tradeoff), while
// "Security Engineer" lands in security.
const RULES: Rule[] = [
  { category: "executive_leadership", pattern: /\b(chief\s+\w+\s+officer|\bce[o]\b|\bcto\b|\bcfo\b|\bcoo\b|\bcpo\b|\bcro\b|\bciso\b|\bgeneral\s+manager\b)\b/i },
  { category: "security", pattern: /\b(security|infosec|soc\s?2|compliance|penetration\s+test|incident\s+response)\b/i },
  { category: "people_recruiting", pattern: /\b(recruiter|recruiting|talent\s+acquisition|talent\s+partner|hr\s+business\s+partner|people\s+operations|people\s+partner)\b/i },
  { category: "legal", pattern: /\b(counsel|attorney|legal|compliance\s+officer|paralegal)\b/i },
  { category: "finance", pattern: /\b(finance|financial|accountant|accounting|controller|treasury|fp&a|payroll)\b/i },
  { category: "sales", pattern: /\b(sales|account\s+executive|business\s+development|bdr|sdr|partnerships?|revenue)\b/i },
  { category: "marketing", pattern: /\b(marketing|growth|brand|content\s+strategist|demand\s+gen|seo\b)\b/i },
  { category: "customer_success", pattern: /\b(customer\s+success|customer\s+support|support\s+engineer|technical\s+support|solutions\s+engineer)\b/i },
  { category: "design", pattern: /\b(designer|design\s+lead|ux\b|ui\b|product\s+design)\b/i },
  { category: "product", pattern: /\b(product\s+manager|product\s+owner|\bpm\b)\b/i },
  { category: "operations", pattern: /\b(operations|office\s+manager|logistics|supply\s+chain|facilities)\b/i },
  { category: "engineering", pattern: /\b(engineer|engineering|developer|programmer|architect|devops|sre\b|data\s+scientist|machine\s+learning|\bml\b|infrastructure)\b/i },
];

export function classifyRole(title: string): RoleCategory {
  for (const rule of RULES) if (rule.pattern.test(title)) return rule.category;
  return "other";
}

// ---- narrow, conservative "notable first hire" sub-signals -------------------------------------------------------
//
// Per the V2-2A brief's own example: "Enterprise Account Executive" can deterministically support
// an enterprise-sales signal; a vague title should not. Each of these requires a SPECIFIC pair of
// keywords, not a single loose word, to avoid overclaiming what a title means.

/** Sales role explicitly targeting larger/strategic accounts, not sales in general. */
export function isEnterpriseSalesRole(title: string): boolean {
  return /\b(enterprise|strategic|major\s+account|named\s+account)\b/i.test(title) && /\b(account\s+executive|sales|business\s+development)\b/i.test(title);
}

export function isRecruitingRole(title: string): boolean {
  return /\b(recruiter|recruiting|talent\s+acquisition)\b/i.test(title);
}

export function isSecurityComplianceRole(title: string): boolean {
  return /\b(security|infosec|soc\s?2|compliance|ciso)\b/i.test(title);
}
