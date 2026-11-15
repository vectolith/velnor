# VELNOR Model Family Contract

Status: proposed engineering contract  
Models: VELNOR Core Prime and VELNOR Core Prima  
Foundation models: Prime = `Qwen/Qwen3-8B`; Prima = `Qwen/Qwen3-14B`

## 1. Product relationship

VELNOR Core Prime and VELNOR Core Prima are two capability tiers in one coherent VELNOR model family.

- **Core Prime** is the foundational VELNOR tier. It establishes the family's general reasoning, instruction-following, technical assistance, practical problem-solving, identity, and behavioural baseline.
- **Core Prima** is the advanced flagship tier. It extends those capabilities with harder training objectives and stronger performance on complex tasks. It is not defined as Prime with a larger dataset or merely a larger parameter count.

Prima must retain the shared VELNOR identity and behavioural contract while demonstrating measurable capability gains over Prime.

## 2. Shared family contract

Both models must implement the same versioned family-level contract:

1. **Identity:** Both identify as VELNOR models built by Vectolith. Each accurately names its own tier and foundation model when asked. Neither claims to be the other.
2. **Behaviour:** Both follow the same principles for accuracy, clarity, respect, calibrated uncertainty, privacy, and honest representation of capabilities.
3. **Instruction hierarchy:** Both use the same hierarchy for system, developer, and user instructions. Neither tier may bypass family-level safety or policy constraints.
4. **Safety and refusals:** Both share refusal boundaries, safe-completion patterns, and escalation behaviour. Greater capability in Prima must not weaken these guarantees.
5. **Interaction conventions:** Both share response conventions, tool-use discipline, and communication style. Tier-specific capability may change depth and sophistication, not the underlying identity or behavioural principles.
6. **Versioning:** The family contract is versioned independently of model adapters. Each release records the contract version and the exact training/evaluation configuration used.

The shared contract should be maintained as a reusable source artifact, not duplicated as divergent prompt text in separate training scripts. Model-specific identity fields (tier name and base model) should be injected from each model's release configuration.

## 3. Prima's advanced training objectives

Prima must have its own curriculum and independently versioned training data. It must not reuse Prime's curriculum as its sole or primary training objective, and it must not inherit Prime's adapter weights unless a separately reviewed experiment explicitly justifies that choice.

Prima's curriculum should emphasize increased task difficulty and depth in these areas:

- **Multi-step reasoning:** Long-horizon problems, dependency tracking, constraint satisfaction, decomposition, and verification of intermediate conclusions.
- **Technical depth:** More demanding software engineering, debugging, architecture, systems design, quantitative analysis, and code review tasks.
- **Planning and execution:** Convert ambiguous goals into robust plans, track prerequisites, handle tool failures, and verify outcomes before reporting completion.
- **Knowledge synthesis:** Reconcile conflicting evidence, distinguish facts from assumptions, and produce traceable conclusions.
- **Robust instruction-following:** Resolve competing constraints, preserve user intent across long contexts, and identify underspecified requirements without fabricating details.
- **Self-verification:** Detect likely errors, test proposed solutions where possible, and communicate residual uncertainty.

Training examples should include hard negatives, edge cases, adversarially phrased instructions, incomplete information, multi-turn context, and tasks with objectively checkable outcomes. Data quality, provenance, licensing, contamination controls, and held-out separation must be recorded.

## 4. Comparative evaluation and promotion gates

Prima is not promoted to flagship solely because it trains successfully or has lower training loss. It must be evaluated against the released Prime checkpoint and the applicable base-model baseline.

Use the same frozen, held-out evaluation suite, prompt templates, decoding settings, tool permissions, and scoring rubric for each comparison. Keep training data and benchmark data disjoint. Report per-domain results, aggregate results, sample counts, confidence intervals where appropriate, and failure examples.

Required evaluation dimensions:

| Dimension | What is measured |
| --- | --- |
| Reasoning | Correctness on difficult multi-step and constraint-based tasks |
| Technical competence | Code correctness, debugging accuracy, architecture quality, and quantitative problem solving |
| Planning and execution | Plan validity, dependency handling, tool-use success, and verified completion |
| Instruction-following | Compliance with layered constraints and preservation of user intent |
| Knowledge synthesis | Evidence quality, contradiction handling, and uncertainty calibration |
| Reliability | Factual error rate, unsupported claims, and consistency across paraphrases |
| Family consistency | Correct tier identity and adherence to the shared behavioural contract |
| Safety | Refusal correctness and safe handling of disallowed or risky requests |

### Minimum promotion criteria

Prima must satisfy all of the following before being called the advanced flagship:

1. **Overall improvement:** Demonstrate a statistically credible improvement over Core Prime on the pre-registered aggregate capability score. Report effect size and confidence interval; do not infer improvement from training loss.
2. **Advanced-task improvement:** Improve on the pre-registered hard reasoning, technical, and multi-step execution subsets. Gains must be visible in per-domain results, not only in the aggregate.
3. **No critical regressions:** Do not regress below Prime's release baseline on safety, identity correctness, instruction hierarchy, or refusal correctness. Any critical failure blocks promotion pending remediation.
4. **Reliability:** Do not trade correctness for verbosity or unsupported confidence. Track hallucination/unsupported-claim rates and calibration alongside task success.
5. **Reproducibility:** Preserve dataset manifests, code revision, base model revision, adapter configuration, seeds, evaluation configuration, and machine-readable reports.
6. **Release integrity:** Publish adapter weights, tokenizer artifacts (or an explicit, verified reference to the unchanged base tokenizer), model configuration, and checksums to the designated model storage. Link the immutable artifact revision from the repository.

The existing small generation smoke suite may remain a regression check, but it is not sufficient evidence for flagship promotion. The release benchmark should be broad enough to support per-domain comparisons and confidence estimates.

## 5. Interoperability requirements

Interoperability means shared identity and behaviour, not interchangeable weights.

- Both tiers use the same family-level system contract and compatible conversation/message conventions.
- Shared identity and policy tests run against both checkpoints on every release.
- Model metadata declares `family=VELNOR`, `tier=prime|prima`, `family_contract_version`, and the exact foundation model/revision.
- Applications may select either tier without changing the user's mental model of VELNOR's identity, safety boundaries, or interaction conventions.
- Tier selection may change reasoning depth, context/resource requirements, and advanced capability, but must not change core behavioural commitments.
- Adapters, tokenizers, and checkpoints remain model-specific. Never load a Prime adapter onto the Prima base or imply that the two weight sets are interchangeable.

## 6. Release checklist

- [ ] Shared family contract is versioned and consumed by both training/evaluation paths.
- [ ] Prime identity and behaviour regression suite passes.
- [ ] Prima has a separate curriculum, dataset manifest, and training configuration.
- [ ] Prima is trained on the declared Qwen3-14B base revision.
- [ ] Prime and Prima are evaluated on the same frozen comparative benchmark.
- [ ] Prima meets every promotion gate, with reports and failure analysis retained.
- [ ] Cross-tier identity, behaviour, instruction-hierarchy, and safety tests pass.
- [ ] Adapter/tokenizer artifacts and checksums are stored and linked from the repository.
- [ ] Release notes state measured improvements and known limitations; no unsupported claims of superiority.

## 7. Non-negotiable distinction

**Prime defines the VELNOR foundation. Prima advances VELNOR's capabilities. Both remain recognizably VELNOR.**

A successful training run is not a successful release. Prima earns flagship status only through reproducible comparative evidence.
