# Fine-Tuning Guide

This document covers the full plan for fine-tuning a local or cloud LLM to improve
conversation intelligence quality beyond the 94.1% within-5-points ceiling reached
through prompt engineering alone.

## Why fine-tune?

Prompt engineering has hit a ceiling with our current public dataset (17 labeled records):

| Metric | Prompt engineering ceiling | Fine-tuning target |
|--------|---------------------------|-------------------|
| Within 5 pts (score100) | 94.1% | ≥97% |
| Polarity match | 82.3% | ≥90% |
| Run-to-run variance | ±15 pts (non-det) | ±3 pts |

The remaining failures are **calibration problems**, not reasoning problems:
- `abcd-ticket-004`: model gives 18, analyst gives 14 — straddles NEGATIVE/VERY_NEGATIVE boundary
- `support-email-001`: model varies 35–50 across cold-starts — thinking-token non-determinism
- `abcd-ticket-001`: model under-credits agent resolution actions by 4–6 pts

Fine-tuning teaches the model *your* scoring scale from labeled examples rather than
inferring it from prompt rules on every inference. This fixes calibration drift and
reduces non-determinism.

---

## Dataset

### What we have

| Source | Records | Has transcript | Usable |
|--------|---------|----------------|--------|
| `fixtures/public-data/pipeline-suite.json` + research suites | 17 | ✅ | ✅ Training |
| `fixtures/sentiment-reviewed-outcomes.support.json` | 20 | ❌ | Eval only |
| `fixtures/benchmarks/gold-label-reviewed-100.jsonl` | 142 | ❌ (synthetic labels) | Labels reference only |

17 real (transcript + analyst label) pairs + 33 synthetic Claude Haiku generated examples = **50 total**.
This meets the minimum viable threshold for LoRA fine-tuning with meaningful generalization.

### Export and augment the training JSONL

**Step 1 — Export real records (17 examples):**
```bash
npx tsx examples/export-fine-tuning-dataset.ts \
  --output output/fine-tuning \
  --split 0.8
```

**Step 2 — Generate synthetic augmentation (~33 examples via Claude Haiku):**
```bash
ANTHROPIC_API_KEY=sk-... npx tsx examples/generate-synthetic-training-data.ts
```

**Step 3 — Merge into combined dataset (50 total):**
```bash
npx tsx examples/merge-fine-tuning-datasets.ts
```

This produces:
- `output/fine-tuning/combined-train.jsonl` — 40 examples (14 real + 26 synthetic, 80%)
- `output/fine-tuning/combined-eval.jsonl` — 10 examples (3 real + 7 synthetic, 20%)
- `output/fine-tuning/manifest-combined.json` — metadata with distribution breakdown

Each line is a complete OpenAI-format chat example:
```json
{
  "messages": [
    {"role": "system", "content": "You are a conversation-intelligence extraction assistant. Return only valid JSON."},
    {"role": "user",   "content": "<full production prompt with transcript>"},
    {"role": "assistant", "content": "<ideal JSON output with analyst score100, polarity, key moments>"}
  ]
}
```

The user message is built by the **exact same** `buildOllamaCompatPrompt` function used
at inference time, so the model learns the real prompt shape.

### Augmenting to 50+ examples

With only 17 real records you should augment before training:

1. **Manual review** — go through `fixtures/benchmarks/gold-label-reviewed-100.jsonl`,
   pick 30 synthetic records with interesting patterns, write matching synthetic transcripts
   (1–2 pages of dialogue), and add them to the training set.

2. **Claude-assisted generation** — use the Anthropic API to generate 5 synthetic
   transcripts per engagement type (CALL / EMAIL / TICKET / CHAT) with controlled
   sentiment labels (e.g. "write a 12-turn support call transcript where the customer
   is frustrated about a missed delivery, score 28"). Manually verify the labels.

3. **Paraphrase existing** — each real transcript can be lightly paraphrased (names,
   product references changed) to double the set. Pass `--augment` when it is
   implemented in the export script.

---

## Training options

### Option A — OpenAI gpt-4o-mini (recommended first step)

**Pros:** No GPU needed, cheapest, 10-example minimum, fast iteration.
**Cons:** Proprietary, API dependency, can't run via Ollama locally.
**Cost:** ~$3–10 for 17 examples × 3 epochs.

```bash
pip install openai

# Upload training file
openai api files.create -f output/fine-tuning/train.jsonl -p fine-tune

# Start fine-tuning job
openai api fine_tuning.jobs.create \
  -t <train_file_id> \
  -v <eval_file_id> \
  -m gpt-4o-mini \
  --hyperparameters n_epochs=3

# Monitor
openai api fine_tuning.jobs.list
openai api fine_tuning.jobs.retrieve <job_id>
```

Once the job is complete, you get a model ID like `ft:gpt-4o-mini:your-org::abc123`.
Use it by setting:
```bash
OPENAI_API_KEY=sk-... CI_RLM_MODEL=ft:gpt-4o-mini:your-org::abc123
```
The engine will use it in `structured` mode (full RLM pipeline).

---

### Option B — Qwen3-8B via Axolotl QLoRA (local, free) ✅ Recommended

**Pros:** Runs locally via Ollama after training, no ongoing API cost, you own the weights.
Qwen3-8B matches Qwen2.5-14B quality at half the size. Supports non-thinking mode at
inference time (`think: false`) to eliminate token-burn non-determinism.
**Cons:** Requires Linux/cloud for Axolotl (no Apple Silicon). ~2–4 hours on a rented GPU.
**Cost:** ~$1–5 cloud GPU rental (RunPod A40 at ~$0.40/hr × 2–4h).

**Why Qwen3-8B over Qwen2.5-7B (original plan):**
- Qwen3-8B ≈ Qwen2.5-14B quality — better reasoning for the same VRAM
- Built-in non-thinking mode fixes the ±15 pt cold-start variance problem
- Only 6 GB VRAM for QLoRA training (fits easily on A40 48GB / A100 80GB)
- ~9 GB VRAM for Ollama inference (fits in 16GB serving GPU)
- No 7B model exists in Qwen3; the ladder is 4B → 8B → 14B

**Known Axolotl gotchas for Qwen3:**
- `fix_untrained_tokens: false` — required or training breaks
- `chat_template: tokenizer_default` — not `chatml` (different special token IDs)
- JSON output issues are a vLLM constrained-decoding bug; we use Ollama + manual
  `extractJsonObject()` parsing so this does **not** affect us

#### Install

```bash
pip install axolotl torch transformers peft datasets accelerate bitsandbytes
```

#### Config (`docs/axolotl-qlora.yml`)

```yaml
base_model: Qwen/Qwen3-8B
model_type: AutoModelForCausalLM
tokenizer_type: AutoTokenizer

load_in_4bit: true
strict: false
fix_untrained_tokens: false      # Required for Qwen3

datasets:
  - path: output/fine-tuning/combined-train.jsonl
    type: chat_template
    chat_template: tokenizer_default   # Not chatml — Qwen3 uses different token IDs

val_set_size: 0.0          # We use our own eval file
output_dir: ./output/qwen3-8b-finetuned

adapter: lora
lora_r: 32              # Higher than Qwen2.5 plan (50 examples, more headroom)
lora_alpha: 64
lora_dropout: 0.05
lora_target_linear: true

sequence_len: 8192
sample_packing: false

micro_batch_size: 1
gradient_accumulation_steps: 4
num_epochs: 3
learning_rate: 0.0002
optimizer: adamw_bnb_8bit
lr_scheduler: cosine
warmup_ratio: 0.1
weight_decay: 0.01

bf16: auto
tf32: false
gradient_checkpointing: true
logging_steps: 1
save_strategy: epoch
```

#### Train

```bash
axolotl train docs/axolotl-qlora.yml
```

#### Export to Ollama

After training, merge the LoRA adapter into the base model and convert for Ollama:

```bash
# Merge adapter
python -c "
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer
base = AutoModelForCausalLM.from_pretrained('Qwen/Qwen3-8B')
model = PeftModel.from_pretrained(base, './output/qwen3-8b-finetuned')
model = model.merge_and_unload()
model.save_pretrained('./output/qwen3-8b-merged')
AutoTokenizer.from_pretrained('Qwen/Qwen3-8B').save_pretrained('./output/qwen3-8b-merged')
"

# Convert to GGUF and load into Ollama
# (requires llama.cpp convert script — https://github.com/ggerganov/llama.cpp)
python llama.cpp/convert_hf_to_gguf.py ./output/qwen3-8b-merged \
  --outtype q4_k_m --outfile qwen3-ci.gguf

ollama create qwen3-ci -f - <<'EOF'
FROM ./qwen3-ci.gguf
PARAMETER temperature 0
PARAMETER num_ctx 8192
EOF

# Run validation against the fine-tuned model
OLLAMA_MODEL=qwen3-ci CI_RLM_MODE=ollama_json_compat \
  npx tsx examples/run-gold-label-validation.ts
```

---

## Overfitting prevention

With 50 examples, overfitting risk is lower than before but still real. These settings help:

| Control | Setting | Why |
|---------|---------|-----|
| LoRA rank | r=32 | Higher than before (50 examples, A40 headroom) |
| Epochs | 3 max | Stop before the model memorizes examples |
| Early stopping | patience=2 | Halt if eval loss rises |
| Dropout | 0.05 | Adds noise to LoRA layers |
| Weight decay | 0.01 | Penalizes large parameter changes |
| Learning rate | 2e-4 | Small updates — conservative adaptation |

**Mandatory:** hold out at least 10 records for evaluation, never include them in training.
We currently have 10 eval records (3 real + 7 synthetic) in `combined-eval.jsonl`.

---

## Testing plan

### Step 1 — Run the gold-label validation pipeline

```bash
# OpenAI fine-tuned model
OPENAI_API_KEY=sk-... CI_RLM_MODEL=ft:gpt-4o-mini:org::id \
  npx tsx examples/run-gold-label-validation.ts

# Local Qwen3-8B fine-tuned via Ollama
OLLAMA_MODEL=qwen3-ci CI_RLM_MODE=ollama_json_compat \
  npx tsx examples/run-gold-label-validation.ts
```

Compare the output against the pre-fine-tuning baseline:

| Metric | Baseline (qwen3:30b, no FT) | Target |
|--------|----------------------------|--------|
| Within 5 pts | 94.1% | ≥97% |
| Polarity match | 82.3% | ≥90% |
| Avg delta score100 | 3.18 | ≤2.0 |
| Run-to-run variance | ±15 pts | ±3 pts |

### Step 2 — Run twice to check variance

Non-determinism is the key issue with the current model. A fine-tuned Qwen3-8B at
`temperature=0` with `think: false` should produce identical results across cold starts.

```bash
for i in 1 2; do
  OLLAMA_MODEL=qwen3-ci CI_RLM_MODE=ollama_json_compat \
    npx tsx examples/run-gold-label-validation.ts \
    --output output/ft-run-$i
done

# Compare the two runs record by record
diff \
  <(cat output/ft-run-1/validation-records.jsonl | python3 -c "import json,sys; [print(json.loads(l)['recordId'], json.loads(l).get('modelScore100')) for l in sys.stdin]") \
  <(cat output/ft-run-2/validation-records.jsonl | python3 -c "import json,sys; [print(json.loads(l)['recordId'], json.loads(l).get('modelScore100')) for l in sys.stdin]")
```

### Step 3 — Regression check

Run the full unit test suite to confirm the fine-tuned model doesn't break existing
schema validation or parsing:

```bash
npm test
```

### Step 4 — Check the specific failure records

The 3 persistent failures are the most important to verify:

```bash
OLLAMA_MODEL=qwen3-ci CI_RLM_MODE=ollama_json_compat \
  npx tsx examples/run-gold-label-validation.ts 2>&1 | \
  grep -E "email-001|ticket-001|ticket-004" 2>&1 | grep -v "^$"
```

Expected post-FT behavior:
- `support-email-001`: score 27–32 (was 35–50), polarity=NEGATIVE ✓
- `abcd-ticket-001`: score 22–28 (was 18–24), delta ≤3 ✓
- `abcd-ticket-004`: score 12–16 (was 18), polarity=VERY_NEGATIVE ✓

---

## Decision criteria

| Outcome | Action |
|---------|--------|
| ≥97% within5 AND ≥90% polarity | Ship — switch `OLLAMA_MODEL` / `CI_RLM_MODEL` in production config |
| 94–97% within5 but improved polarity | Ship with monitoring — net positive |
| No improvement or regression | Add more training examples (aim for 50+), retrain |
| Significant overfitting (eval loss diverges) | Reduce epochs to 2, increase dropout to 0.1 |
