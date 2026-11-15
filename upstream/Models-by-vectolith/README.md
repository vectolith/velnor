# Models by vectolith

Canonical upstream project for the VELNOR model family. This repository owns foundation selection, model specifications, training pipelines, evaluation, artifacts, and releases. The downstream `vectolith/velnor` repository consumes approved releases and remains intact.

## Model family

| Model | Role | Distinct training objective |
|---|---|---|
| **VELNOR Core Prime** | General-purpose assistant: conversation, instruction following, reasoning, coding, knowledge work, and tool use | Broad capability, instruction adherence, reasoning reliability, coding competence, and conversational consistency |
| **VELNOR Core Prima** | Specialist assistant: research synthesis, technical investigation, structured analysis, and multi-step problem solving | Evidence-grounded synthesis, source comparison, uncertainty calibration, decomposition, and reproducible analytical workflows |

Prime and Prima are independent student models, not one checkpoint with different names. They share VELNOR identity, behaviour, safety, and interoperability contracts. Their foundations may differ when evidence supports that choice.

## Collective distillation

The initial teacher candidate pool covers IBM Granite, Google Gemma, Mistral Ministral, and Alibaba Qwen families. Teachers contribute independently generated responses, critiques, disagreement signals, and curated examples. Do not merge weights across different architectures. Use logit-level distillation only when tokenizer and output compatibility are proven.

Teachers are training-time dependencies only. Released students must run independently without teacher inference.

## Current status

This is the initial project scaffold. **No foundation has been selected, no expensive training has started, and no trained student weights are claimed to exist.** Candidate selection must precede expensive training.

- [Architecture](docs/architecture.md)
- [Foundation selection](docs/foundation-selection.md)
- [Collective distillation](docs/collective-distillation.md)
- [Training and promotion](docs/training-and-promotion.md)
- [Release policy](docs/release-policy.md)

## Principles

1. Evidence before selection; selection before expensive training.
2. Immutable model revisions and verified licenses.
3. Separate objectives, datasets, evaluations, and promotion for Prime and Prima.
4. Shared family identity, safety baseline, and interoperability.
5. Reproducible runs, auditable data lineage, honest model cards.
6. Never commit credentials, private datasets, or large model weights to Git.

## Licensing

The source-code license does not automatically apply to foundation models, teacher outputs, datasets, or model weights. Record each component's actual license and obligations separately.
