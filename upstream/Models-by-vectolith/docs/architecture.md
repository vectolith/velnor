# Model family architecture

## Canonical topology

- **Models by vectolith** is the canonical model-development source.
- **VELNOR** is the downstream product/integration repository.
- **Core Prime** and **Core Prima** are independently trained, versioned, evaluated, and released students.

## Shared family contract

Both students must share VELNOR identity, instruction hierarchy, safety baseline, disclosure conventions, message/tool-call conventions, serialization expectations, and user-facing interaction principles. Cross-model handoff must not create contradictory identity or incompatible assumptions.

Interoperability is validated at interface and behavioural levels. Identical architecture, tokenizer, or internal representation is not required.

## Distinct specialization

**Prime:** general-purpose conversation, instruction following, reasoning, coding, broad knowledge, and reliable tool use.

**Prima:** research decomposition, technical investigation, evidence synthesis, source comparison, uncertainty calibration, and structured analytical work. Prima is not merely Prime trained on more data or a larger checkpoint.

## Teacher/student separation

Teachers supervise training only. Released students must be independently loadable with their own weights, configuration, tokenizer/processor, and runtime requirements.

## Architecture neutrality

Do not assume Qwen or any single vendor. The initial trainer may support only reviewed decoder-only causal-LM layouts. Mark unsupported architectures incompatible until the harness is extended and tested; never silently force a candidate through an incompatible trainer.
