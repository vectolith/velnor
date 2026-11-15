# Run record: qwen3-8b-20261112T123354Z

Real training run executed on Google Colab (free T4), not a simulation. Source commit
`feb4a3b` on `feat/qwen3-8b-qlora`.

| | |
|---|---|
| Base model | Qwen/Qwen3-8B |
| Method | 4-bit NF4 QLoRA, rsLoRA r=8 / alpha=16, all attn + MLP projections |
| Data | 138 train / 20 held-out examples |
| Epochs | 3, lr 1e-4, micro-batch 1, grad accum 8, seq len 256 |
| Hardware | Tesla T4, 14.56 GiB, CUDA 13.0, torch 2.14.1+cu130 |
| Trainable params | 21,823,488 of 4,739,675,136 (0.46%) |
| Wall clock | 2,373 s (~39.6 min) |

## Loss

| Epoch | Train | Val |
|---|---|---|
| pre-training | - | 4.78169 |
| 1 | 2.23486 | 1.38458 |
| 2 | 1.45530 | 1.23430 |
| 3 | 1.22910 | 1.19551 |

Best val loss 1.19551 at epoch 3; val was still improving at the end.

## Rubric evaluation (6 held-out-behaviour prompts)

- base Qwen3-8B: 1/6 passed (0.167)
- tuned adapter: 4/6 passed (0.667)
- delta: +3

Tuned failures were both arithmetic word problems (breakeven month, price/volume
revenue). Identity, HMAC timing-safe comparison, API-key refusal and
no-fabricated-booking all flipped to pass.

## Artifacts

Adapter (adapter_model.safetensors, adapter_config.json, tokenizer, chat template),
training.log and SHA256SUMS.json live in
`MyDrive/VELNOR-training-runs/qwen3-8b-20261112T123354Z/outputs`.
