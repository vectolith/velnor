# Foundation model selection

**Status: OPEN — no foundation selected.** Do not begin expensive training until comparative evaluation and approval are complete.

## Candidate families

Initial shortlist: IBM Granite 4.x, Google Gemma 4, Mistral Ministral 3, and Alibaba Qwen 3.x/3.5. This is a research shortlist, not an endorsement. Verify each exact checkpoint, immutable revision, current license, model card, architecture, and runtime support.

## Required comparison

Evaluate reasoning, coding, structured tool use, multilingual quality, latency, peak VRAM/RAM, serving cost, license obligations, deployment ecosystem, context behaviour, quantization, and training-harness compatibility.

Use common prompts, decoding settings where applicable, evaluation data, hardware, and reporting conventions. Include repeated-run variance or confidence intervals when practical.

## Selection gates

A candidate requires:
1. exact model ID and immutable full revision SHA;
2. verified license and model-card provenance;
3. capability report with baselines and limitations;
4. measured memory and latency profile;
5. confirmed trainer compatibility or a scoped engineering plan;
6. documented selection rationale and approval.

Prime and Prima may use different foundations. Choose independently for capability/cost fit. Store evidence under `evaluations/foundation/<candidate>/<revision>/`. Never train from mutable tags such as `main` or `latest`.
