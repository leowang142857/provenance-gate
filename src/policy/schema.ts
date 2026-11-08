import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const shareSchema = z.number().min(0).max(1);

export const ruleWhenSchema = z
  .object({
    /** Globs (picomatch). When present the rule is evaluated per matching file. */
    paths: z.array(z.string().min(1)).min(1).optional(),
    /** Match when the effective AI share is >= this value. Use a tiny value such as 0.0001 for "any AI touch". */
    ai_share_gte: shareSchema.optional(),
    /** Match when the effective AI share is < this value. */
    ai_share_lt: shareSchema.optional(),
    /** Match when any involved agent's tool, model or "tool/model" matches one of these globs. */
    agents: z.array(z.string().min(1)).min(1).optional(),
    /** Match when commits (or matching files) have no provenance signal at all. */
    provenance_missing: z.boolean().optional(),
    /** Match only when at least this many lines (added + deleted) are in scope. */
    min_changed_lines: z.number().int().min(0).optional(),
  })
  .strict();

export const ruleRequireSchema = z
  .object({
    human_approvals: z.number().int().min(0).optional(),
    /** At least one approval must come from a member of one of these teams. */
    teams: z.array(z.string().min(1)).min(1).optional(),
    /** At least one approval must come from one of these logins. */
    reviewers: z.array(z.string().min(1)).min(1).optional(),
    /** Labels to apply when the rule matches. Informational; never blocks on its own. */
    labels: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export const ruleSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    when: ruleWhenSchema.default({}),
    require: ruleRequireSchema.optional(),
    /**
     * block (default): unmet requirements, or a match with no requirements, fail the check.
     * warn: the same conditions only produce a warning.
     */
    action: z.enum(['block', 'warn']).optional(),
    message: z.string().optional(),
  })
  .strict()
  .refine((rule) => rule.require !== undefined || rule.action !== undefined, {
    message: 'a rule needs either `require` or `action`',
  });

export const policySchema = z
  .object({
    version: z.literal(1),
    defaults: z
      .object({
        /** How to treat commits that carry no provenance signal. */
        unknown_provenance: z.enum(['treat-as-ai', 'treat-as-human', 'block']).default('treat-as-ai'),
        /** Whether approvals from bot accounts count towards `human_approvals`. */
        count_bot_approvals: z.boolean().default(false),
      })
      .strict()
      .default({}),
    rules: z.array(ruleSchema).min(1),
  })
  .strict();

export type Policy = z.infer<typeof policySchema>;
export type PolicyRule = Policy['rules'][number];
export type PolicyDefaults = Policy['defaults'];

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export function parsePolicy(yamlText: string): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new PolicyError(`policy is not valid YAML: ${(error as Error).message}`);
  }
  const result = policySchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
      .join('\n');
    throw new PolicyError(`policy failed validation:\n${issues}`);
  }
  return result.data;
}
