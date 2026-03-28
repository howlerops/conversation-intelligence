import { z } from 'zod';

const looseMetadataSchema = z.record(z.string(), z.unknown()).optional().default({});

export const participantSchema = z.object({
  speakerId: z.string().min(1),
  displayName: z.string().min(1),
  rawRoleLabel: z.string().optional(),
  metadata: looseMetadataSchema,
});

export type Participant = z.infer<typeof participantSchema>;
export type ParticipantInput = z.input<typeof participantSchema>;

export const transcriptTurnSchema = z.object({
  turnId: z.string().min(1),
  speakerId: z.string().min(1),
  text: z.string().min(1),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  metadata: looseMetadataSchema,
});

export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;
export type TranscriptTurnInput = z.input<typeof transcriptTurnSchema>;

export const transcriptInputSchema = z.object({
  tenantId: z.string().min(1),
  conversationId: z.string().optional(),
  useCase: z.string().default('support'),
  participants: z.array(participantSchema).min(1),
  turns: z.array(transcriptTurnSchema).min(1),
  metadata: looseMetadataSchema,
});

export type TranscriptInput = z.infer<typeof transcriptInputSchema>;
export type TranscriptInputDraft = z.input<typeof transcriptInputSchema>;
