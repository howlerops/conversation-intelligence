import { TranscriptInput } from '../contracts/transcript';
import { TranscriptLengthBucket } from '../contracts/model-validation';

export interface TranscriptStats {
  transcriptTurnCount: number;
  transcriptCharacterCount: number;
  transcriptLengthBucket: TranscriptLengthBucket;
}

export function deriveTranscriptStats(
  transcript: Pick<TranscriptInput, 'turns'>,
): TranscriptStats {
  const transcriptTurnCount = transcript.turns.length;
  const transcriptCharacterCount = transcript.turns.reduce((sum, turn) => sum + turn.text.length, 0);

  return {
    transcriptTurnCount,
    transcriptCharacterCount,
    transcriptLengthBucket: bucketTranscriptLength(transcriptCharacterCount),
  };
}

export function bucketTranscriptLength(
  transcriptCharacterCount: number,
): TranscriptLengthBucket {
  if (transcriptCharacterCount <= 300) {
    return 'SHORT';
  }
  if (transcriptCharacterCount <= 1200) {
    return 'MEDIUM';
  }
  if (transcriptCharacterCount <= 4000) {
    return 'LONG';
  }
  return 'VERY_LONG';
}
