# Sentiment Scoring Review Task

Reviewed on 2026-03-28.

Current status:

- derived sentiment scoring is implemented in `src/sentiment/scoring.ts`
- starter calibration fixtures exist in `fixtures/sentiment-calibration.support.json`
- calibration coverage now spans all five display buckets with 18 reviewed support fixtures
- calibration checks now allow bounded tolerance drift instead of exact-match-only expectations
- reviewed sentiment outcome validation now exists in `fixtures/sentiment-reviewed-outcomes.support.json`
- analyst review decisions can now persist corrected sentiment labels for later export and drift analysis
- tenant admin config can now carry engagement-specific score100 offsets for runtime calibration
- reviewed datasets can now produce recommended engagement-specific offsets before applying them to runtime traffic
- the canonical extraction fields remain the source of truth

## Current Runtime Shape

The current canonical sentiment contract stores:

- `polarity`: `VERY_NEGATIVE`, `NEGATIVE`, `NEUTRAL`, `POSITIVE`, or `VERY_POSITIVE`
- `intensity`: `0..1`
- `confidence`: `0..1`
- `rationale`

That is good for extraction and verification, but it is not yet the best operator-facing score for dashboards, triage, or trend reporting.

## Problem To Solve

We need one user-facing sentiment score that is:

- easy to read in the run console and future reports
- stable enough for alerting and trend comparisons
- compatible with analyst review and correction workflows
- still traceable back to the canonical extraction fields

## Options

### Option A: Replace sentiment with a 1-5 score

Pros:

- easy to explain
- easy to visualize

Cons:

- loses polarity/intensity detail
- makes verifier thresholds and model debugging weaker
- pushes too much meaning into one coarse field

Status: not recommended as the canonical storage model.

### Option B: Keep current fields and add a derived 1-5 score

Pros:

- minimal contract risk
- easy to expose in UI
- keeps current extraction logic intact

Cons:

- 1-5 alone is still coarse for analytics
- mapping will need calibration

Status: implemented as the current UI-facing layer.

### Option C: Keep current fields and add both `score100` and derived `score5`

Pros:

- better internal resolution for analytics and alerts
- simple 1-5 display for humans
- preserves current extraction fields as the source of truth

Cons:

- requires a clear mapping and calibration pass

Status: implemented provisionally through the current `derived_v1` mapping, with optional `derived_v1_calibrated` offsets when tenant admin config enables sentiment scoring calibration.

## Recommendation

Do not replace the current canonical sentiment fields yet.

Instead:

1. keep `polarity`, `intensity`, and `confidence` as the extraction source of truth
2. define a derived `score100` for analytics and alerting
3. derive `score5` from `score100` for UI and reporting
4. calibrate both against analyst-reviewed support conversations before making them release-gating fields
5. keep calibration explicit and tenant-scoped instead of silently mutating the base mapping

## Proposed First Mapping

This is a starting point for review, not a final contract:

- `NEGATIVE`: `score100 = round(50 - intensity * 50)`
- `NEUTRAL`: `score100 = 50`
- `POSITIVE`: `score100 = round(50 + intensity * 50)`

Then derive:

- `1` => `0-20`
- `2` => `21-40`
- `3` => `41-60`
- `4` => `61-80`
- `5` => `81-100`

This gives us a deterministic baseline before we decide whether a model-native scalar should replace it later.

## Current Calibration Path

The runtime now supports:

- recommending score100 offsets from reviewed datasets with `npm run recommend:sentiment-scoring`
- applying engagement-specific offsets through tenant admin config
- validating reviewed datasets with or without a calibration config by passing an optional second argument to `npm run eval:sentiment:reviewed`

The current intended use is:

1. derive recommendations from reviewed exports
2. inspect the recommended offsets
3. apply them explicitly in tenant admin config
4. compare baseline vs calibrated reviewed validation before enabling the runtime calibration

## Follow-Up Tasks

- expand the current 18-fixture calibration set into a larger analyst-reviewed dataset
- compare derived scores against analyst review outcomes on real redacted exports, not just checked-in fixtures
- push the reviewed dataset well beyond the current fixture set before auto-applying calibration recommendations
- define whether future alerts should use `score100`, `score5`, or both
- refine score display and filtering in the run console after broader calibration
- decide whether mixed/ambivalent sentiment needs a richer canonical representation than the current polarity enum
