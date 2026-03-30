import { OverallSentiment, SpeakerAssignment } from '../contracts/analysis';
import { NormalizedTranscript } from '../pipeline/normalize-transcript';
import { applyAdditionalSentimentScoreOffset } from './scoring';

export interface SupportSentimentCueProfile {
  repeatContact: boolean;
  brokenPromise: boolean;
  severeOutage: boolean;
  documentationMismatch: boolean;
  policyConflict: boolean;
  escalationDemand: boolean;
  gratitude: boolean;
  resolutionConfirmation: boolean;
  businessDeadline: boolean;
  shipmentOrRefundIssue: boolean;
  hardshipOrPaymentPlan: boolean;
  feeDispute: boolean;
  repeatedReplacementFailure: boolean;
}

export function buildSupportSentimentCueProfile(
  transcript: NormalizedTranscript,
  assignments: SpeakerAssignment[],
): SupportSentimentCueProfile {
  const assignmentByTurnId = new Map(assignments.map((assignment) => [assignment.turnId, assignment]));
  const nonSystemTurns = transcript.turns.filter((turn) => {
    const assignment = assignmentByTurnId.get(turn.turnId);
    return assignment
      && assignment.role !== 'ADMIN'
      && assignment.role !== 'SYSTEM'
      && assignment.role !== 'BOT';
  });
  const endUserTurns = transcript.turns.filter((turn) => {
    const assignment = assignmentByTurnId.get(turn.turnId);
    return assignment?.role === 'END_USER' && assignment.eligibleForSentiment;
  });

  const fullText = nonSystemTurns.map((turn) => turn.normalizedText).join(' ').toLowerCase();
  const endUserText = endUserTurns.map((turn) => turn.normalizedText).join(' ').toLowerCase();

  return {
    repeatContact: /(second time|third time|three times|explained this three times|replied three times|replied twice|still waiting|followed up again|again\b|last few days|still has not fixed|still hasn't fixed|still not fixed)/.test(endUserText),
    brokenPromise: /(supposed to|promised|would be here yesterday|update window|still has not happened|still has not fixed|still hasn't fixed|past the date|nothing has arrived|missing tracking|return label)/.test(endUserText),
    severeOutage: /(outage|manual rebuild|manually rebuilding|incident command|leadership|root-cause|unstable|reopen the service externally)/.test(fullText),
    documentationMismatch: /(setup article|screenshots|portal|menus that are not on my account|instructions|documentation|article says|page says|published guidance|claims form|return article|warranty page)/.test(endUserText),
    policyConflict: /(article says|page says|published guidance|told me i was already too late|do not match the published guidance|form rejected me|rejected me without both documents|conflicting documentation)/.test(endUserText),
    escalationDemand: /(escalat|supervisor|higher level of action|need a named owner)/.test(fullText),
    gratitude: /\b(thanks|thank you|appreciate|glad to hear|made the difference)\b/.test(fullText),
    resolutionConfirmation: /(fixed while i was on the line|refund posted|import completed cleanly|resolved|closed the case|confirmed the new date|issue fixed)/.test(fullText),
    businessDeadline: /(launch checklist|leadership team|before seven|reopen the service externally|deadline)/.test(endUserText),
    shipmentOrRefundIssue: /(refund|return label|tracking|shipment|warehouse|replacement|sku|arrived)/.test(endUserText),
    hardshipOrPaymentPlan: /(cannot make the full payment|can send .* on friday|hardship|cannot keep paying|revised payment|payment on tuesday|payment on friday)/.test(endUserText),
    feeDispute: /(late fee|extra charges every week|fee still posted|fee dispute)/.test(endUserText),
    repeatedReplacementFailure: /(second replacement|same incorrect model as the first one|wrong replacement)/.test(endUserText),
  };
}

export function applySupportSentimentCueAdjustments(
  sentiment: OverallSentiment | null,
  options: {
    engagementType?: 'CALL' | 'EMAIL' | 'TICKET' | 'CHAT';
    profile: SupportSentimentCueProfile;
  },
): OverallSentiment | null {
  if (!sentiment?.score || !options.engagementType) {
    return sentiment;
  }

  const delta = resolveSupportCueScoreAdjustment(sentiment, options.profile, options.engagementType);
  if (delta === 0) {
    return sentiment;
  }

  return {
    ...sentiment,
    score: applyAdditionalSentimentScoreOffset(sentiment.score, {
      additionalScore100Offset: delta,
      context: {
        engagementType: options.engagementType,
        polarity: sentiment.polarity,
      },
    }),
  };
}

function resolveSupportCueScoreAdjustment(
  sentiment: OverallSentiment,
  profile: SupportSentimentCueProfile,
  engagementType: 'CALL' | 'EMAIL' | 'TICKET' | 'CHAT',
): number {
  const current = sentiment.score?.score100;
  if (typeof current !== 'number') {
    return 0;
  }

  if (sentiment.polarity === 'NEGATIVE' || sentiment.polarity === 'VERY_NEGATIVE') {
    if (profile.repeatContact && profile.escalationDemand && profile.brokenPromise) {
      return clampToMaximum(current, 18);
    }
    if (profile.severeOutage && (profile.businessDeadline || profile.brokenPromise)) {
      return clampToMaximum(current, 18);
    }
    if (profile.policyConflict && profile.documentationMismatch) {
      return clampToMaximum(current, 28);
    }
    if (profile.brokenPromise && profile.repeatContact && (profile.businessDeadline || profile.repeatedReplacementFailure)) {
      return clampToMaximum(current, 20);
    }
    if (profile.brokenPromise && profile.repeatContact) {
      return clampToMaximum(current, 22);
    }
    if (profile.feeDispute && profile.hardshipOrPaymentPlan) {
      return clampToMaximum(current, 28);
    }
    if (profile.brokenPromise && profile.shipmentOrRefundIssue) {
      return clampToMaximum(current, 28);
    }
    if (profile.documentationMismatch && profile.repeatContact) {
      return clampToMaximum(current, 36);
    }
    if (profile.hardshipOrPaymentPlan) {
      return clampToRange(current, 28, 38);
    }
  }

  if (sentiment.polarity === 'POSITIVE' || sentiment.polarity === 'VERY_POSITIVE') {
    if (profile.gratitude && profile.resolutionConfirmation && engagementType === 'CALL') {
      return clampToRange(current, 78, 85);
    }
    if (profile.gratitude && profile.resolutionConfirmation && engagementType === 'EMAIL') {
      return clampToRange(current, 72, 78);
    }
  }

  return 0;
}

function clampToMaximum(score100: number, maximum: number): number {
  return Math.min(0, maximum - score100);
}

function clampToRange(score100: number, minimum: number, maximum: number): number {
  if (score100 < minimum) {
    return minimum - score100;
  }
  if (score100 > maximum) {
    return maximum - score100;
  }
  return 0;
}
