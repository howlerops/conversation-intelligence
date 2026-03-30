import {
  runSentimentCalibration,
  summarizeSentimentCalibration,
} from '../src/evals/run-sentiment-calibration';

const results = runSentimentCalibration();

for (const result of results) {
  const status = result.passed ? 'PASS' : 'FAIL';
  console.log(
    `${status} ${result.name} score100=${result.actualScore100}/${result.expectedScore100} delta100=${result.deltaScore100} score5=${result.actualScore5}/${result.expectedScore5} delta5=${result.deltaScore5}`,
  );
}

const failures = results.filter((result) => !result.passed);
const summary = summarizeSentimentCalibration(results);
console.log(
  `SUMMARY total=${summary.total} passed=${summary.passed} maxDelta100=${summary.maxDeltaScore100} maxDelta5=${summary.maxDeltaScore5} avgDelta100=${summary.averageDeltaScore100.toFixed(2)} avgDelta5=${summary.averageDeltaScore5.toFixed(2)} byScore5=${JSON.stringify(summary.byScore5)} byCategory=${JSON.stringify(summary.byCategory)}`,
);
if (failures.length > 0) {
  process.exitCode = 1;
}
