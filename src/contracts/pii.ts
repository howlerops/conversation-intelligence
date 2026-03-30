import { z } from 'zod';

export const piiRegexRuleSchema = z.object({
  name: z.string().min(1),
  pattern: z.string().min(1),
  flags: z.string().default('g'),
  replacement: z.string().optional(),
});

export type PiiRegexRule = z.infer<typeof piiRegexRuleSchema>;
export type PiiRegexRuleDraft = z.input<typeof piiRegexRuleSchema>;

export const piiConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maskDisplayNames: z.boolean().default(false),
  reversible: z.boolean().default(false),
  customRegexRules: z.array(piiRegexRuleSchema).default([]),
});

export type PiiConfig = z.infer<typeof piiConfigSchema>;
export type PiiConfigDraft = z.input<typeof piiConfigSchema>;

export const piiRedactionSummarySchema = z.object({
  applied: z.boolean(),
  redactionCount: z.number().int().min(0),
  ruleHits: z.record(z.string(), z.number().int().min(0)).default({}),
});

export type PiiRedactionSummary = z.infer<typeof piiRedactionSummarySchema>;
