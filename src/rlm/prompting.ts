import { CanonicalRole } from '../contracts/roles';
import { SpeakerAssignment } from '../contracts/analysis';
import { TenantPack } from '../contracts/tenant-pack';
import { NormalizedTranscript } from '../pipeline/normalize-transcript';

export const CANONICAL_ANALYSIS_PROMPT_VERSION = 'support-v0.1';

function formatTurn(
  turn: NormalizedTranscript['turns'][number],
  assignment: SpeakerAssignment,
): string {
  return [
    `[${turn.turnId}]`,
    `[speaker_id=${turn.speakerId}]`,
    `[role=${assignment.role}]`,
    `[eligible_sentiment=${assignment.eligibleForSentiment}]`,
    `[eligible_key_moment=${assignment.eligibleForKeyMoments}]`,
    `${turn.displayName}: ${turn.normalizedText}`,
  ].join(' ');
}

function joinRoles(roles: CanonicalRole[]): string {
  return roles.join(', ');
}

export function buildCanonicalAnalysisPrompt(
  transcript: NormalizedTranscript,
  assignments: SpeakerAssignment[],
  pack: TenantPack,
): { query: string; context: string; promptVersion: string } {
  const assignmentByTurnId = new Map(assignments.map((assignment) => [assignment.turnId, assignment]));

  const renderedTranscript = transcript.turns
    .map((turn) => formatTurn(turn, assignmentByTurnId.get(turn.turnId)!))
    .join('\n');

  const query = [
    'You are analyzing a support transcript for production conversation intelligence.',
    `Only score sentiment for roles in: ${joinRoles(pack.analysisPolicy.sentimentRoles)}.`,
    `Only emit end-user key moments for roles in: ${joinRoles(pack.analysisPolicy.keyMomentRoles)}.`,
    'Other roles may be used as context only.',
    `Limit events to these canonical types: ${pack.supportedCanonicalEventTypes.join(', ')}.`,
    'Return evidence using transcript turn ids and short verbatim quotes.',
    'If evidence is weak, keep the output conservative and add a review reason.',
  ].join(' ');

  const contextSections = [
    `tenant_id: ${transcript.tenantId}`,
    `conversation_id: ${transcript.conversationId ?? 'unknown'}`,
    `use_case: ${transcript.useCase}`,
    `pack_version: ${pack.packVersion}`,
    '',
    'policy_digest:',
    ...(pack.policyDigest.length > 0 ? pack.policyDigest.map((item) => `- ${item}`) : ['- none']),
    '',
    'speaker_assignments:',
    ...assignments.map((assignment) => `- ${assignment.turnId}: ${assignment.displayName} => ${assignment.role} (${assignment.confidence.toFixed(2)})`),
    '',
    'transcript:',
    renderedTranscript,
  ];

  return {
    query,
    context: contextSections.join('\n'),
    promptVersion: CANONICAL_ANALYSIS_PROMPT_VERSION,
  };
}
