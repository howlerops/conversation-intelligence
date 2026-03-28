import { CanonicalRole } from '../contracts/roles';
import { SpeakerAssignment } from '../contracts/analysis';
import { TenantPack } from '../contracts/tenant-pack';
import { NormalizedTranscript, NormalizedTurn } from './normalize-transcript';

const ROLE_KEYWORDS: Array<[CanonicalRole, string[]]> = [
  ['END_USER', ['customer', 'claimant', 'borrower', 'shopper', 'caller', 'member', 'user']],
  ['AGENT', ['agent', 'rep', 'csr', 'advisor', 'associate', 'specialist']],
  ['SUPERVISOR', ['supervisor', 'manager', 'lead']],
  ['ADMIN', ['admin', 'internal note', 'note', 'backoffice']],
  ['SYSTEM', ['system', 'workflow', 'event']],
  ['BOT', ['bot', 'assistant', 'automation', 'ivr']],
];

interface RoleInference {
  role: CanonicalRole;
  confidence: number;
  provenance: string[];
}

function inferRoleFromMetadata(kind?: unknown): RoleInference | null {
  if (typeof kind !== 'string') {
    return null;
  }

  const normalized = kind.trim().toLowerCase();

  if (['external', 'customer', 'member', 'caller', 'end_user', 'claimant', 'borrower'].includes(normalized)) {
    return { role: 'END_USER', confidence: 0.99, provenance: [`metadata.kind=${normalized}`] };
  }

  if (['employee', 'agent', 'csr', 'representative', 'case_worker'].includes(normalized)) {
    return { role: 'AGENT', confidence: 0.99, provenance: [`metadata.kind=${normalized}`] };
  }

  if (['supervisor', 'manager'].includes(normalized)) {
    return { role: 'SUPERVISOR', confidence: 0.99, provenance: [`metadata.kind=${normalized}`] };
  }

  if (['admin', 'internal', 'note'].includes(normalized)) {
    return { role: 'ADMIN', confidence: 0.99, provenance: [`metadata.kind=${normalized}`] };
  }

  if (['system', 'workflow'].includes(normalized)) {
    return { role: 'SYSTEM', confidence: 0.99, provenance: [`metadata.kind=${normalized}`] };
  }

  if (['bot', 'assistant', 'ivr'].includes(normalized)) {
    return { role: 'BOT', confidence: 0.99, provenance: [`metadata.kind=${normalized}`] };
  }

  return null;
}

function inferRoleFromAliases(turn: NormalizedTurn, pack: TenantPack): RoleInference | null {
  const aliasCandidates = [
    turn.normalizedDisplayName,
    String(turn.rawRoleLabel ?? '').trim().toLowerCase(),
  ].filter(Boolean);

  for (const alias of aliasCandidates) {
    const mapped = pack.roleAliases[alias];
    if (mapped) {
      return { role: mapped, confidence: 0.95, provenance: [`tenant.roleAlias=${alias}`] };
    }
  }

  return null;
}

function inferRoleFromSpeakerId(turn: NormalizedTurn, pack: TenantPack): RoleInference | null {
  const mapped = pack.speakerIdRoleMap[turn.speakerId];

  if (!mapped) {
    return null;
  }

  return { role: mapped, confidence: 0.98, provenance: [`tenant.speakerIdRoleMap=${turn.speakerId}`] };
}

function inferRoleFromMarkers(turn: NormalizedTurn): RoleInference | null {
  if (turn.markers.includes('ADMIN_MARKER')) {
    return { role: 'ADMIN', confidence: 0.97, provenance: ['turn.marker=ADMIN_MARKER'] };
  }

  if (turn.markers.includes('SYSTEM_MARKER')) {
    return { role: 'SYSTEM', confidence: 0.97, provenance: ['turn.marker=SYSTEM_MARKER'] };
  }

  if (turn.markers.includes('BOT_MARKER')) {
    return { role: 'BOT', confidence: 0.97, provenance: ['turn.marker=BOT_MARKER'] };
  }

  return null;
}

function inferRoleFromName(turn: NormalizedTurn): RoleInference | null {
  const haystack = `${turn.normalizedDisplayName} ${turn.normalizedText}`.toLowerCase();

  for (const [role, keywords] of ROLE_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      return {
        role,
        confidence: role === 'END_USER' || role === 'AGENT' ? 0.72 : 0.66,
        provenance: [`heuristic.keyword=${role}`],
      };
    }
  }

  return null;
}

function inferRole(turn: NormalizedTurn, transcript: NormalizedTranscript, pack: TenantPack): RoleInference {
  const participant = transcript.participantsBySpeakerId.get(turn.speakerId);

  const orderedInferences = [
    inferRoleFromSpeakerId(turn, pack),
    inferRoleFromMarkers(turn),
    inferRoleFromMetadata(participant?.metadata.kind),
    inferRoleFromAliases(turn, pack),
    inferRoleFromName(turn),
  ];

  for (const inference of orderedInferences) {
    if (inference) {
      return inference;
    }
  }

  return {
    role: 'UNKNOWN',
    confidence: 0.35,
    provenance: ['fallback=UNKNOWN'],
  };
}

export function resolveSpeakers(
  transcript: NormalizedTranscript,
  pack: TenantPack,
): SpeakerAssignment[] {
  return transcript.turns.map((turn) => {
    const inference = inferRole(turn, transcript, pack);

    return {
      turnId: turn.turnId,
      speakerId: turn.speakerId,
      displayName: turn.displayName,
      role: inference.role,
      confidence: inference.confidence,
      provenance: inference.provenance,
      markers: turn.markers,
      eligibleForSentiment: pack.analysisPolicy.sentimentRoles.includes(inference.role),
      eligibleForKeyMoments: pack.analysisPolicy.keyMomentRoles.includes(inference.role),
    };
  });
}
