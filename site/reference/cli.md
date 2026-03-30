# CLI Reference

## Core runtime

- npm run serve:dev — start the local server
- npm run serve:standalone — start the standalone app shell
- npm run analyze:fixture — analyze the default fixture
- npm run embedded:fixture — run the embedded example

## Test and eval

- npm run typecheck
- npm test
- npm run eval:fixtures
- npm run eval:sentiment
- npm run eval:sentiment:reviewed

## Benchmark loops

- npm run benchmark:e2e
- npm run benchmark:e2e:isolated
- npm run loop:e2e
- npm run loop:e2e:isolated
- npm run loop:e2e:trial-matrix:isolated
- npm run loop:e2e:reviewed
- npm run loop:e2e:public-scale:isolated
- npm run loop:e2e:public-reviewed

## Dataset and validation tooling

- npm run build:public-test-pipelines
- npm run build:reviewed-benchmark
- npm run annotate:reviewed-benchmark
- npm run compare:public-shadow
- npm run export:reviewed-runs
- npm run refresh:reviewed-runs
- npm run inspect:reviewed-datasets
- npm run validate:model
- npm run recommend:validation-thresholds
- npm run apply:validation-thresholds
- npm run recommend:sentiment-scoring

## Docs

- npm run docs:dev
- npm run docs:build
- npm run docs:preview
