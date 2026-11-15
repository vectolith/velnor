# Release and artifact policy

Each release includes model weights/configuration, tokenizer or processor, model card, intended use, immutable foundation/training lineage, dataset manifest and license summary, evaluation report, promotion decision, runtime compatibility metadata, SHA-256 checksums, and known limitations.

Do not commit large weights to Git. Store them in an approved versioned model registry or large-file store and link immutable artifacts from release metadata. Git contains source, manifests, documentation, evaluation summaries, and artifact pointers.

Version Prime and Prima independently. Never overwrite published artifacts. Verify checksums before loading and preserve previous releases for rollback.

The repository source license does not automatically license foundations, teacher outputs, datasets, or trained weights. Record each component's actual license and obligations.
