import { z } from 'zod';

export const canonicalRoleSchema = z.enum([
  'END_USER',
  'AGENT',
  'SUPERVISOR',
  'ADMIN',
  'SYSTEM',
  'BOT',
  'UNKNOWN',
]);

export type CanonicalRole = z.infer<typeof canonicalRoleSchema>;

export const reviewStateSchema = z.enum([
  'VERIFIED',
  'UNCERTAIN',
  'NEEDS_REVIEW',
]);

export type ReviewState = z.infer<typeof reviewStateSchema>;

export const sentimentPolaritySchema = z.enum([
  'VERY_NEGATIVE',
  'NEGATIVE',
  'NEUTRAL',
  'POSITIVE',
  'VERY_POSITIVE',
]);

export type SentimentPolarity = z.infer<typeof sentimentPolaritySchema>;

export const impactLevelSchema = z.enum([
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
]);

export type ImpactLevel = z.infer<typeof impactLevelSchema>;
