import { ConversationAnalysis, SpeakerAssignment } from '../contracts/analysis';
import { TenantPack } from '../contracts/tenant-pack';

function assignmentForTurn(
  assignments: SpeakerAssignment[],
  turnId: string,
): SpeakerAssignment | undefined {
  return assignments.find((assignment) => assignment.turnId === turnId);
}

export function verifyAnalysis(
  analysis: ConversationAnalysis,
  pack: TenantPack,
): ConversationAnalysis {
  const reasons = new Set(analysis.review.reasons);
  const sentimentRoles = new Set(analysis.analysisScope.sentimentRoles);
  const keyMomentRoles = new Set(analysis.analysisScope.keyMomentRoles);
  const thresholds = pack.reviewThresholds;

  if (analysis.speakerSummary.confidence < thresholds.minimumSpeakerSummaryConfidence) {
    reasons.add('Speaker confidence is below the configured production threshold.');
  }

  for (const assignment of analysis.speakerAssignments) {
    const isScoredRole = assignment.eligibleForSentiment || assignment.eligibleForKeyMoments;

    if (isScoredRole && assignment.confidence < pack.analysisPolicy.speakerConfidenceReviewThreshold) {
      reasons.add(`Speaker assignment ${assignment.turnId} is below the configured role-confidence threshold.`);
    }
  }

  if (
    analysis.overallEndUserSentiment &&
    analysis.overallEndUserSentiment.confidence < thresholds.minimumOverallSentimentConfidence
  ) {
    reasons.add('Overall end-user sentiment confidence is below threshold.');
  }

  for (const aspect of analysis.aspectSentiments) {
    if (aspect.confidence < thresholds.minimumAspectConfidence) {
      reasons.add(`Aspect sentiment ${aspect.target}/${aspect.aspect} is below threshold.`);
    }

    for (const evidence of aspect.evidence) {
      const assignment = assignmentForTurn(analysis.speakerAssignments, evidence.turnId);

      if (!assignment) {
        reasons.add(`Aspect evidence references unknown turn ${evidence.turnId}.`);
        continue;
      }

      if (!sentimentRoles.has(assignment.role)) {
        reasons.add(`Aspect evidence on turn ${evidence.turnId} is not from an eligible sentiment role.`);
      }
    }
  }

  for (const event of analysis.canonicalEvents) {
    if (event.confidence < thresholds.minimumEventConfidence) {
      reasons.add(`Canonical event ${event.type} is below threshold.`);
    }

    if (
      (event.businessImpact === 'HIGH' || event.businessImpact === 'CRITICAL') &&
      event.evidence.length < thresholds.minimumHighImpactEvidenceCount
    ) {
      reasons.add(`Canonical event ${event.type} does not meet the high-impact evidence minimum.`);
    }
  }

  for (const moment of analysis.canonicalKeyMoments) {
    if (moment.confidence < thresholds.minimumKeyMomentConfidence) {
      reasons.add(`Key moment ${moment.type} is below threshold.`);
    }

    if (!keyMomentRoles.has(moment.actorRole)) {
      reasons.add(`Key moment ${moment.type} is attributed to ineligible role ${moment.actorRole}.`);
    }

    if (
      (moment.businessImpact === 'HIGH' || moment.businessImpact === 'CRITICAL') &&
      moment.evidence.length < thresholds.minimumHighImpactEvidenceCount
    ) {
      reasons.add(`Key moment ${moment.type} does not meet the high-impact evidence minimum.`);
    }

    for (const evidence of moment.evidence) {
      const assignment = assignmentForTurn(analysis.speakerAssignments, evidence.turnId);

      if (!assignment) {
        reasons.add(`Key moment evidence references unknown turn ${evidence.turnId}.`);
        continue;
      }

      if (!keyMomentRoles.has(assignment.role)) {
        reasons.add(`Key moment evidence on turn ${evidence.turnId} is not from an eligible key-moment role.`);
      }
    }
  }

  return {
    ...analysis,
    review: {
      ...analysis.review,
      state: reasons.size > 0 ? 'NEEDS_REVIEW' : analysis.review.state,
      reasons: Array.from(reasons),
    },
  };
}
