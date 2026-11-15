# Training and promotion

## Training prerequisites

Training is blocked until foundations are selected and pinned to immutable revisions; licenses are reviewed; data provenance and splits are documented; trainer compatibility is proven; baselines are complete; GPU capacity and run budget are explicitly approved; and reproducible configurations and rollback plans exist.

Do not launch expensive jobs on smoke-test data or unverified hardware assumptions.

## Independent runs

Prime and Prima require separate run IDs, configurations, datasets, checkpoints, evaluation reports, and promotion decisions. Every run records model and tokenizer revisions, dataset hashes, training-code commit, hyperparameters, seed, hardware/runtime versions, logs, checkpoints, and limitations.

## Promotion gates

A release must pass training integrity/reproducibility, held-out role-specific capability tests, regressions against foundation and previous release, safety/instruction hierarchy, tool-use/serialization conformance, family identity/interoperability, latency/memory/deployment smoke tests, and license/artifact/model-card completeness.

A failed gate blocks promotion. Training loss alone is never sufficient. Prime and Prima may be promoted independently.
