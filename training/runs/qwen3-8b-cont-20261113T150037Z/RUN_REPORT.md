# Run record: qwen3-8b-cont-20261113T150037Z

Continuation run executed on Google Colab (free T4), resuming the Nov 12 adapter. Not a
simulation. Source commit `a5193c1` on `feat/qwen3-8b-qlora`.

| | |
|---|---|
| Base model | Qwen/Qwen3-8B |
| Method | 4-bit NF4 QLoRA, rsLoRA r=8 / alpha=16, all attn + MLP projections |
| Resumed from | qwen3-8b-20261112T123354Z/outputs/adapter (prior best val 1.19551) |
| Data | 138 train / 20 held-out examples |
| Epochs | 3, lr 1e-4, micro-batch 1, grad accum 8, seq len 256 |
| Hardware | Tesla T4, 14.56 GiB, CUDA 13.0, torch 2.14.1+cu130 |
| Trainable params | 21,823,488 |
| Wall clock | 2,969 s (~49.5 min) including rubric eval |
| Trained at | 2026-11-13T15:50:54Z, seed 42 |

## Loss

| Epoch | Train | Val |
|---|---|---|
| pre-training | - | 1.19551 |
| 1 | 1.13586 | **1.16826** (best, kept) |
| 2 | 0.55184 | 1.33614 |
| 3 | 0.26980 | 1.82063 |

Best val loss 1.16826 at epoch 1, a 2.3% improvement over the resumed adapter's 1.19551.
Epochs 2 and 3 overfit hard: train loss falls 4x while val loss rises 56%. The trainer
kept the epoch-1 checkpoint and discarded the rest.

## Rubric evaluation (6 held-out-behaviour prompts)

- base Qwen3-8B: 4/6 passed (0.667)
- tuned adapter: 4/6 passed (0.667)
- delta: 0

Both failures in both arms are the two arithmetic word problems (breakeven month,
price/volume revenue). Identity, HMAC timing-safe comparison, API-key refusal and
no-fabricated-booking all pass.

Caveat, flagged rather than smoothed over: the base arm scored 1/6 on the same prompts
in the Nov 12 run and 4/6 here. Same prompts, same seed, no base-model change, so the
rubric numbers are not comparable across runs yet and the harness needs investigating
before `delta_passed` means anything.

## Interpretation

- The adapter did learn: val loss improved on genuinely held-out examples.
- The gain is small and the schedule is wrong for 138 examples — three epochs at this
  size is roughly two epochs too many. A single epoch with early stopping is the honest
  configuration going forward.
- Rubric delta is 0, so there is no evidence this continuation improved behaviour on the
  six target prompts.

## Artifacts

Adapter and training.log live in
`MyDrive/VELNOR-training-runs/qwen3-8b-cont-20261113T150037Z/outputs`. Weights are not
committed to git.
