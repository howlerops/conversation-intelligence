import { TranscriptInput } from '../contracts/transcript';

export interface NormalizedParticipant {
  speakerId: string;
  displayName: string;
  normalizedDisplayName: string;
  rawRoleLabel?: string;
  metadata: Record<string, unknown>;
}

export interface NormalizedTurn {
  turnId: string;
  speakerId: string;
  displayName: string;
  normalizedDisplayName: string;
  rawRoleLabel?: string;
  text: string;
  normalizedText: string;
  metadata: Record<string, unknown>;
  markers: string[];
}

export interface NormalizedTranscript {
  tenantId: string;
  conversationId?: string;
  useCase: string;
  participants: NormalizedParticipant[];
  participantsBySpeakerId: Map<string, NormalizedParticipant>;
  turns: NormalizedTurn[];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeLabel(value: string): string {
  return collapseWhitespace(value).toLowerCase();
}

function inferMarkers(text: string, displayName: string, rawRoleLabel?: string): string[] {
  const haystack = `${displayName} ${rawRoleLabel ?? ''} ${text}`.toLowerCase();
  const markers: string[] = [];

  if (/\[(admin|internal|note)\]/.test(haystack) || /\binternal note\b/.test(haystack)) {
    markers.push('ADMIN_MARKER');
  }

  if (/\[(system|workflow)\]/.test(haystack) || /\bsystem message\b/.test(haystack)) {
    markers.push('SYSTEM_MARKER');
  }

  if (/\[(bot|assistant)\]/.test(haystack) || /\bvirtual assistant\b/.test(haystack)) {
    markers.push('BOT_MARKER');
  }

  return markers;
}

export function normalizeTranscript(input: TranscriptInput): NormalizedTranscript {
  const participants = input.participants.map((participant) => ({
    speakerId: participant.speakerId,
    displayName: collapseWhitespace(participant.displayName),
    normalizedDisplayName: normalizeLabel(participant.displayName),
    rawRoleLabel: participant.rawRoleLabel ? collapseWhitespace(participant.rawRoleLabel) : undefined,
    metadata: participant.metadata ?? {},
  }));

  const participantsBySpeakerId = new Map(
    participants.map((participant) => [participant.speakerId, participant]),
  );

  const turns = input.turns.map((turn) => {
    const participant = participantsBySpeakerId.get(turn.speakerId);
    const displayName = participant?.displayName ?? turn.speakerId;
    const normalizedDisplayName = participant?.normalizedDisplayName ?? normalizeLabel(turn.speakerId);
    const normalizedText = collapseWhitespace(turn.text);

    return {
      turnId: turn.turnId,
      speakerId: turn.speakerId,
      displayName,
      normalizedDisplayName,
      rawRoleLabel: participant?.rawRoleLabel,
      text: turn.text,
      normalizedText,
      metadata: turn.metadata ?? {},
      markers: inferMarkers(normalizedText, displayName, participant?.rawRoleLabel),
    };
  });

  return {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    useCase: input.useCase,
    participants,
    participantsBySpeakerId,
    turns,
  };
}
