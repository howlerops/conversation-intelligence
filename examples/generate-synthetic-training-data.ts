/**
 * Generate synthetic conversation transcripts + gold-label analysis pairs
 * using the Anthropic API.
 *
 * Each generated example is written as an OpenAI chat-format JSONL line
 * matching the format produced by export-fine-tuning-dataset.ts, so both
 * can be concatenated into a single training file.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/generate-synthetic-training-data.ts
 *   [--output dir]   (default: output/fine-tuning)
 *   [--concurrency n] (default: 3)
 *   [--dry-run]      print scenarios without calling the API
 */
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Scenario definitions — what we want the model to generate.
// Spread across all 4 engagement types and all 5 polarity buckets.
// Emphasis on the boundary zones that caused failures in validation.
// ---------------------------------------------------------------------------

interface ScenarioSpec {
  id: string;
  engagementType: 'CALL' | 'EMAIL' | 'TICKET' | 'CHAT';
  targetScore: number;         // 0-100 analyst score
  polarity: 'VERY_NEGATIVE' | 'NEGATIVE' | 'NEUTRAL' | 'POSITIVE' | 'VERY_POSITIVE';
  canonicalEvents: string[];
  turns: number;               // approximate turn count
  scenario: string;            // natural-language description for generation prompt
}

const SCENARIOS: ScenarioSpec[] = [
  // ── CALL (10 new) ───────────────────────────────────────────────────────
  {
    id: 'synth-call-001',
    engagementType: 'CALL',
    targetScore: 12,
    polarity: 'VERY_NEGATIVE',
    canonicalEvents: ['FRUSTRATION_ONSET', 'ESCALATION_REQUEST', 'REPEAT_CONTACT_SIGNAL'],
    turns: 14,
    scenario: 'Customer calls about a multi-day internet outage affecting their home business. They have called 4 times already and each time are told maintenance is scheduled. They demand a supervisor and threaten to cancel.',
  },
  {
    id: 'synth-call-002',
    engagementType: 'CALL',
    targetScore: 28,
    polarity: 'NEGATIVE',
    canonicalEvents: ['PROMISE_BROKEN', 'REFUND_DELAY'],
    turns: 10,
    scenario: 'Customer calls about a refund they were promised 3 weeks ago that still hasn\'t appeared. They are frustrated but remain polite. Agent confirms the refund was not processed and creates a new ticket.',
  },
  {
    id: 'synth-call-003',
    engagementType: 'CALL',
    targetScore: 22,
    polarity: 'NEGATIVE',
    canonicalEvents: ['HARDSHIP_SIGNAL', 'PROMISE_TO_PAY', 'RESOLUTION_COMMITMENT'],
    turns: 12,
    scenario: 'Customer calls unable to pay their utility bill. They recently lost their job and ask for a payment plan. Agent sets up a 3-month plan. Customer agrees but is clearly stressed.',
  },
  {
    id: 'synth-call-004',
    engagementType: 'CALL',
    targetScore: 50,
    polarity: 'NEUTRAL',
    canonicalEvents: ['RESOLUTION_COMMITMENT'],
    turns: 8,
    scenario: 'Customer calls to update their billing address. Process is smooth but the agent mentions a 2-3 day delay for changes to take effect. Customer is neither happy nor upset — purely transactional.',
  },
  {
    id: 'synth-call-005',
    engagementType: 'CALL',
    targetScore: 72,
    polarity: 'POSITIVE',
    canonicalEvents: ['RESOLUTION_COMMITMENT'],
    turns: 10,
    scenario: 'Customer calls because their replacement device arrived damaged. Agent apologizes, expedites a new replacement, and waives the restocking fee. Customer ends the call satisfied.',
  },
  {
    id: 'synth-call-006',
    engagementType: 'CALL',
    targetScore: 90,
    polarity: 'VERY_POSITIVE',
    canonicalEvents: [],
    turns: 8,
    scenario: 'Customer calls to say the technical support team resolved a long-standing issue and wants to leave a compliment. They describe the agent\'s patience and expertise. Pure positive feedback call.',
  },
  {
    id: 'synth-call-007',
    engagementType: 'CALL',
    targetScore: 15,
    polarity: 'VERY_NEGATIVE',
    canonicalEvents: ['FRUSTRATION_ONSET', 'POLICY_CONFLICT', 'RESOLUTION_REJECTION'],
    turns: 16,
    scenario: 'Customer calls because a promised price-lock was not honored after a plan change. They explicitly say this is "bait and switch." Agent cites policy — customer rejects the explanation and says they will dispute the charge with their bank.',
  },
  {
    id: 'synth-call-008',
    engagementType: 'CALL',
    targetScore: 35,
    polarity: 'NEGATIVE',
    canonicalEvents: ['DOCUMENT_BLOCKER', 'REPEAT_CONTACT_SIGNAL'],
    turns: 12,
    scenario: 'Customer has called three times about a missing insurance certificate needed to close their mortgage. Each time they are told it was emailed but they have not received it. Agent resends and escalates.',
  },
  {
    id: 'synth-call-009',
    engagementType: 'CALL',
    targetScore: 65,
    polarity: 'POSITIVE',
    canonicalEvents: ['RESOLUTION_COMMITMENT'],
    turns: 8,
    scenario: 'Customer calls about an incorrect charge on their account. Agent reviews, confirms it was a system error, reverses it immediately, and apologizes. Customer says "thanks, that\'s all I needed."',
  },
  {
    id: 'synth-call-010',
    engagementType: 'CALL',
    targetScore: 18,
    polarity: 'NEGATIVE',
    canonicalEvents: ['PROMISE_BROKEN', 'ESCALATION_REQUEST'],
    turns: 12,
    scenario: 'Small business owner calls because their point-of-sale system has been down for 6 hours despite a promised 2-hour fix window. They are losing sales. Agent escalates to Tier 2.',
  },

  // ── TICKET (8 new) ──────────────────────────────────────────────────────
  {
    id: 'synth-ticket-001',
    engagementType: 'TICKET',
    targetScore: 10,
    polarity: 'VERY_NEGATIVE',
    canonicalEvents: ['FRUSTRATION_ONSET', 'PROMISE_BROKEN', 'REPEAT_CONTACT_SIGNAL'],
    turns: 10,
    scenario: 'Customer ticket about a subscription cancellation they submitted 45 days ago that is still being billed. They have submitted 3 prior tickets all marked resolved without action. Final message explicitly threatens legal action.',
  },
  {
    id: 'synth-ticket-002',
    engagementType: 'TICKET',
    targetScore: 30,
    polarity: 'NEGATIVE',
    canonicalEvents: ['REFUND_DELAY', 'RESOLUTION_COMMITMENT'],
    turns: 6,
    scenario: 'Customer ticket requesting a refund for a double-charge from last month. Agent acknowledges the error, promises refund in 5-7 days, but customer notes this is the second time this has happened.',
  },
  {
    id: 'synth-ticket-003',
    engagementType: 'TICKET',
    targetScore: 48,
    polarity: 'NEUTRAL',
    canonicalEvents: [],
    turns: 4,
    scenario: 'Customer ticket asking for their account data export per GDPR. Agent acknowledges, says it will be ready in 30 days per policy. Customer accepts. No emotion on either side.',
  },
  {
    id: 'synth-ticket-004',
    engagementType: 'TICKET',
    targetScore: 70,
    polarity: 'POSITIVE',
    canonicalEvents: ['RESOLUTION_COMMITMENT'],
    turns: 6,
    scenario: 'Customer ticket about a feature not working on mobile. Agent reproduces the bug, fixes it in staging, and ships a patch. Customer replies "worked perfectly, thanks for the quick fix."',
  },
  {
    id: 'synth-ticket-005',
    engagementType: 'TICKET',
    targetScore: 20,
    polarity: 'NEGATIVE',
    canonicalEvents: ['DOCUMENT_BLOCKER', 'PROMISE_BROKEN'],
    turns: 8,
    scenario: 'Customer ticket: onboarding is stalled because the portal\'s identity verification step keeps failing with a generic error. They have tried 4 times over 2 days. Agent says they\'ll investigate but first response takes 24 hours.',
  },
  {
    id: 'synth-ticket-006',
    engagementType: 'TICKET',
    targetScore: 55,
    polarity: 'NEUTRAL',
    canonicalEvents: [],
    turns: 4,
    scenario: 'Customer ticket asking to change the email on their account. Quick back-and-forth about verification. Done in 2 exchanges. Customer says "all set" — no strong sentiment.',
  },
  {
    id: 'synth-ticket-007',
    engagementType: 'TICKET',
    targetScore: 8,
    polarity: 'VERY_NEGATIVE',
    canonicalEvents: ['FRUSTRATION_ONSET', 'POLICY_CONFLICT', 'ESCALATION_REQUEST'],
    turns: 10,
    scenario: 'Customer ticket about a SaaS platform outage during a critical client demo. They lost a deal. Agent cites SLA policy. Customer escalates to account manager and says they want a credit equal to one month\'s contract value.',
  },
  {
    id: 'synth-ticket-008',
    engagementType: 'TICKET',
    targetScore: 80,
    polarity: 'POSITIVE',
    canonicalEvents: [],
    turns: 4,
    scenario: 'Customer ticket asking for a feature they need. Agent replies that the feature launched in the latest release and links the docs. Customer replies with "perfect timing, exactly what we needed."',
  },

  // ── EMAIL (6 new) ───────────────────────────────────────────────────────
  {
    id: 'synth-email-001',
    engagementType: 'EMAIL',
    targetScore: 14,
    polarity: 'VERY_NEGATIVE',
    canonicalEvents: ['PROMISE_BROKEN', 'REPEAT_CONTACT_SIGNAL', 'FRUSTRATION_ONSET'],
    turns: 6,
    scenario: 'Customer email chain: they were promised a replacement part within 5 business days, it has been 18. They have emailed 4 times. This message has a clear subject "FINAL WARNING" and says they are contacting the CEO.',
  },
  {
    id: 'synth-email-002',
    engagementType: 'EMAIL',
    targetScore: 27,
    polarity: 'NEGATIVE',
    canonicalEvents: ['PROMISE_BROKEN'],
    turns: 4,
    scenario: 'Calm, factual customer email: states that the tracking number provided shows the package never left the warehouse. They have checked three times. No emotional language — just a clear description of the broken promise.',
  },
  {
    id: 'synth-email-003',
    engagementType: 'EMAIL',
    targetScore: 52,
    polarity: 'NEUTRAL',
    canonicalEvents: [],
    turns: 4,
    scenario: 'Customer email asking for an invoice copy for their accountant. Agent sends it. Customer replies "received, thank you." Purely administrative.',
  },
  {
    id: 'synth-email-004',
    engagementType: 'EMAIL',
    targetScore: 75,
    polarity: 'POSITIVE',
    canonicalEvents: ['RESOLUTION_COMMITMENT'],
    turns: 4,
    scenario: 'Customer email after a support call that resolved their billing issue. They write to say thank you and mention the agent by name as being very helpful. Agent replies with a follow-up confirmation.',
  },
  {
    id: 'synth-email-005',
    engagementType: 'EMAIL',
    targetScore: 32,
    polarity: 'NEGATIVE',
    canonicalEvents: ['HARDSHIP_SIGNAL', 'RESOLUTION_COMMITMENT'],
    turns: 6,
    scenario: 'Customer email explaining they are undergoing chemotherapy and cannot keep up with payments. They ask for a payment holiday. Agent approves a 60-day deferral. Customer is relieved but clearly stressed about the situation.',
  },
  {
    id: 'synth-email-006',
    engagementType: 'EMAIL',
    targetScore: 88,
    polarity: 'VERY_POSITIVE',
    canonicalEvents: [],
    turns: 4,
    scenario: 'Customer email thanking the team for exceptional service during their office relocation — the team proactively rerouted their order with zero disruption. Customer calls it "white-glove service."',
  },

  // ── CHAT (10 new — currently zero in training set) ──────────────────────
  {
    id: 'synth-chat-001',
    engagementType: 'CHAT',
    targetScore: 16,
    polarity: 'VERY_NEGATIVE',
    canonicalEvents: ['FRUSTRATION_ONSET', 'ESCALATION_REQUEST'],
    turns: 16,
    scenario: 'Live chat: customer is trying to complete a purchase but the checkout keeps failing. They have tried 5 times. They are visibly angry in the chat — typing in caps at one point. Agent cannot reproduce the issue and offers a phone callback.',
  },
  {
    id: 'synth-chat-002',
    engagementType: 'CHAT',
    targetScore: 32,
    polarity: 'NEGATIVE',
    canonicalEvents: ['PROMISE_BROKEN', 'REFUND_DELAY'],
    turns: 12,
    scenario: 'Live chat: customer asks where their refund is after 10 business days. Agent checks and says it was "accidentally voided" and will be reissued. Customer is unhappy but doesn\'t escalate.',
  },
  {
    id: 'synth-chat-003',
    engagementType: 'CHAT',
    targetScore: 50,
    polarity: 'NEUTRAL',
    canonicalEvents: [],
    turns: 8,
    scenario: 'Live chat: customer asks for their account number. Agent verifies identity and provides it. Transactional, no sentiment.',
  },
  {
    id: 'synth-chat-004',
    engagementType: 'CHAT',
    targetScore: 68,
    polarity: 'POSITIVE',
    canonicalEvents: ['RESOLUTION_COMMITMENT'],
    turns: 10,
    scenario: 'Live chat: customer locked out of their account. Agent resets access in 3 minutes. Customer says "oh wow that was fast, thanks!"',
  },
  {
    id: 'synth-chat-005',
    engagementType: 'CHAT',
    targetScore: 92,
    polarity: 'VERY_POSITIVE',
    canonicalEvents: [],
    turns: 8,
    scenario: 'Live chat: customer reaches out to say the product exceeded expectations. They run a small business and credit the tool with saving 5 hours per week. They ask how to leave a review.',
  },
  {
    id: 'synth-chat-006',
    engagementType: 'CHAT',
    targetScore: 22,
    polarity: 'NEGATIVE',
    canonicalEvents: ['DOCUMENT_BLOCKER', 'REPEAT_CONTACT_SIGNAL'],
    turns: 14,
    scenario: 'Live chat: customer cannot upload their ID for account verification — the uploader says "file too large" for any file they try. They have been stuck for 2 days. Agent provides a workaround.',
  },
  {
    id: 'synth-chat-007',
    engagementType: 'CHAT',
    targetScore: 38,
    polarity: 'NEGATIVE',
    canonicalEvents: ['POLICY_CONFLICT'],
    turns: 10,
    scenario: 'Live chat: customer wants to transfer their remaining credit to a friend\'s account. Agent explains policy doesn\'t allow it. Customer pushes back multiple times. Agent holds the policy line. Customer accepts but is clearly disappointed.',
  },
  {
    id: 'synth-chat-008',
    engagementType: 'CHAT',
    targetScore: 78,
    polarity: 'POSITIVE',
    canonicalEvents: [],
    turns: 8,
    scenario: 'Live chat: customer has a technical question about API rate limits. Agent gives a clear answer with examples. Customer says it\'s exactly what they needed and asks one follow-up. Ends positively.',
  },
  {
    id: 'synth-chat-009',
    engagementType: 'CHAT',
    targetScore: 12,
    polarity: 'VERY_NEGATIVE',
    canonicalEvents: ['FRUSTRATION_ONSET', 'PROMISE_BROKEN', 'RESOLUTION_REJECTION'],
    turns: 18,
    scenario: 'Live chat: customer was charged twice for an annual subscription. They chatted last week and were told it would be fixed within 48 hours. Still showing both charges. They reject the agent\'s offer of a credit and demand immediate reversal.',
  },
  {
    id: 'synth-chat-010',
    engagementType: 'CHAT',
    targetScore: 45,
    polarity: 'NEUTRAL',
    canonicalEvents: ['RESOLUTION_COMMITMENT'],
    turns: 10,
    scenario: 'Live chat: customer inquires about upgrading their plan. Agent explains options, discusses pricing. Customer says they need to think about it. Agent sends a follow-up summary. Neither positive nor negative outcome.',
  },
];

// ---------------------------------------------------------------------------
// Prompt builder — asks Claude to write a transcript AND its analysis JSON.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are generating synthetic customer support training data for a conversation intelligence system.

For each request you will receive:
- A scenario description
- The target sentiment score (0-100) and polarity label
- The engagement type (CALL, EMAIL, TICKET, or CHAT)
- Expected canonical key moment types

You must return ONLY a valid JSON object with exactly two top-level keys:
1. "transcript" — an array of turns in the correct format for the engagement type
2. "analysis" — the ideal extraction JSON the model should produce

Transcript format rules:
- CALL/CHAT: turns array: [{"turnId":"t1","speakerId":"customer_1","text":"..."},{"turnId":"t2","speakerId":"agent_1","text":"..."},...]
- EMAIL: messages array: [{"messageId":"m1","senderId":"customer_1","bodyText":"...","sentAt":"2026-03-28T10:00:00Z"},...]
- TICKET: comments array: [{"commentId":"c1","authorId":"requester_1","bodyText":"...","createdAt":"2026-03-28T10:00:00Z","isInternalNote":false},...]

Analysis JSON must have exactly these keys:
{
  "summary": string,
  "overallEndUserSentiment": {
    "polarity": "VERY_NEGATIVE"|"NEGATIVE"|"NEUTRAL"|"POSITIVE"|"VERY_POSITIVE",
    "intensity": number 0-1,
    "confidence": number 0-1,
    "rationale": string,
    "score100": integer 0-100
  },
  "canonicalEvents": [{"type": string, "actorRole": "END_USER"|"AGENT"|"SYSTEM", "confidence": number, "rationale": string, "businessImpact": "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", "evidence": [{"turnId": string, "speakerRole": "END_USER"|"AGENT"|"SYSTEM", "quote": string}]}],
  "canonicalKeyMoments": [{"type": string, "actorRole": "END_USER"|"AGENT"|"SYSTEM", "startTurnId": string, "endTurnId": string, "confidence": number, "rationale": string, "businessImpact": "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", "evidence": [{"turnId": string, "speakerRole": "END_USER"|"AGENT"|"SYSTEM", "quote": string}]}],
  "reviewState": "VERIFIED"|"NEEDS_REVIEW"|"UNCERTAIN",
  "reviewReasons": string[]
}

Important:
- score100 MUST match the target score specified in the request (within ±2 points)
- polarity MUST match the target polarity
- Every canonicalEvent MUST also appear in canonicalKeyMoments with matching type
- evidence quotes must be verbatim substrings from the transcript
- turnId in evidence must exist in the transcript
- Use realistic, natural dialogue — avoid clichés`;

function buildUserPrompt(spec: ScenarioSpec): string {
  const polarityRanges: Record<string, string> = {
    VERY_NEGATIVE: '0–20',
    NEGATIVE: '21–44',
    NEUTRAL: '45–55',
    POSITIVE: '56–85',
    VERY_POSITIVE: '86–100',
  };
  return [
    `Engagement type: ${spec.engagementType}`,
    `Target score100: ${spec.targetScore} (${spec.polarity} range: ${polarityRanges[spec.polarity]})`,
    `Target polarity: ${spec.polarity}`,
    `Expected key moment types: ${spec.canonicalEvents.length > 0 ? spec.canonicalEvents.join(', ') : 'none'}`,
    `Approximate turn count: ${spec.turns}`,
    '',
    `Scenario: ${spec.scenario}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The full inference prompt (user message) for the fine-tuning example.
// This must match exactly what engine.ts sends to Ollama at inference time.
// We inline a simplified version here because the export script uses this
// shape, and we need a consistent user-message for training.
// ---------------------------------------------------------------------------

const EVENT_TYPE_GUIDANCE = `=== CANONICAL EVENT TYPES ===
RULE: Every event you emit in canonicalEvents MUST also appear as an entry in canonicalKeyMoments with the same type.
Emit canonicalEvents and matching canonicalKeyMoments for each of these patterns when present:
- FRUSTRATION_ONSET: END_USER explicitly expresses frustration, anger, or distress. actorRole=END_USER.
- PROMISE_BROKEN: A previous commitment was not kept. actorRole=AGENT or SYSTEM.
- REPEAT_CONTACT_SIGNAL: END_USER mentions contacting multiple times or following up. actorRole=END_USER.
- ESCALATION_REQUEST: An escalation occurred. actorRole=END_USER if customer requested; actorRole=AGENT if agent initiated.
- REFUND_DELAY: END_USER asks about or is waiting for a refund/credit. actorRole=END_USER or SYSTEM.
- POLICY_CONFLICT: A policy prevents or contradicts what the END_USER needs. actorRole=AGENT or SYSTEM.
- RESOLUTION_COMMITMENT: AGENT commits to a specific resolution, timeline, or follow-up. actorRole=AGENT.
- RESOLUTION_REJECTION: END_USER rejects the proposed resolution. actorRole=END_USER.
- DOCUMENT_BLOCKER: END_USER cannot proceed due to a missing or inaccessible document. actorRole=END_USER or SYSTEM.
- HARDSHIP_SIGNAL: END_USER discloses financial difficulty or requests a payment plan. actorRole=END_USER.
- PROMISE_TO_PAY: END_USER explicitly commits to making a payment. actorRole=END_USER.`;

const SENTIMENT_RULES = `=== SENTIMENT RULES ===
Base sentiment ONLY on END_USER emotional language.
Keep score100 and polarity consistent:
- VERY_NEGATIVE: 0-20 — explicit rage, severe trust breakdown, threats to cancel/escalate.
- NEGATIVE: 10-40 — frustrated but cooperative, unresolved failures, hardship.
- NEUTRAL: 45-55 — mixed or process-only conversations.
- POSITIVE: 60-85 — resolved or appreciative conversations.
- VERY_POSITIVE: 86-100 — exceptional delight.
Factual statements of unresolved commitments score 20-30 even when calmly stated.
A concrete AGENT action (escalation confirmed, billing alerted) raises score 3-7 points.
Multi-day outages with business impact score 10-16 regardless of tone.`;

function buildInferenceUserMessage(spec: ScenarioSpec, transcript: unknown[]): string {
  const turnLines = transcript.map((t: unknown, i: number) => {
    const turn = t as Record<string, unknown>;
    const id = (turn.turnId ?? turn.messageId ?? turn.commentId ?? `t${i + 1}`) as string;
    const text = (turn.text ?? turn.bodyText ?? '') as string;
    const isCustomer = (turn.speakerId as string ?? turn.senderId as string ?? turn.authorId as string ?? '').includes('customer')
      || (turn.speakerId as string ?? '').includes('requester')
      || (turn.authorId as string ?? '').includes('requester');
    const role = isCustomer ? 'END_USER' : 'AGENT';
    const name = isCustomer ? 'Customer' : 'Agent';
    return `[${id}] [role=${role}] [eligible_sentiment=${isCustomer}] [eligible_key_moment=${isCustomer}] ${name}: ${text}`;
  }).join('\n');

  return [
    'Analyze the support conversation context and task below.',
    'Return ONLY valid JSON — no markdown, no code fences, no extra text before or after.',
    'Use exactly these keys: { "summary": string, "overallEndUserSentiment": {...}|null, "canonicalEvents": [...], "canonicalKeyMoments": [...], "reviewState": string, "reviewReasons": string[] }',
    '',
    EVENT_TYPE_GUIDANCE,
    '',
    SENTIMENT_RULES,
    '',
    `Task: Analyze this ${spec.engagementType.toLowerCase()} support conversation for production conversation intelligence. Score sentiment for END_USER roles only. Return evidence using turn IDs and exact verbatim quotes.`,
    '',
    `Context:\ntenant_id: synthetic_training\nengagement_type: ${spec.engagementType}\n\ntranscript:\n${turnLines}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Generate one example via the Anthropic API
// ---------------------------------------------------------------------------

async function generateOne(
  client: Anthropic,
  spec: ScenarioSpec,
): Promise<{ system: string; user: string; assistant: string } | null> {
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(spec) }],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '';
  let parsed: { transcript: unknown[]; analysis: unknown };
  try {
    // Strip any accidental markdown fences
    const jsonStr = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error(`  [${spec.id}] Failed to parse response JSON`);
    console.error('  Raw:', raw.slice(0, 200));
    return null;
  }

  if (!Array.isArray(parsed.transcript) || parsed.transcript.length === 0) {
    console.error(`  [${spec.id}] No transcript array in response`);
    return null;
  }

  // Validate score is within ±5 of target
  const gotScore = (parsed.analysis as Record<string, unknown> & { overallEndUserSentiment?: { score100?: number } })
    .overallEndUserSentiment?.score100;
  if (typeof gotScore === 'number' && Math.abs(gotScore - spec.targetScore) > 5) {
    console.warn(`  [${spec.id}] Score drift: target=${spec.targetScore} got=${gotScore} (>5pt) — keeping anyway`);
  }

  const system = 'You are a conversation-intelligence extraction assistant. Return only valid JSON.';
  const user = buildInferenceUserMessage(spec, parsed.transcript);
  const assistant = JSON.stringify(parsed.analysis);

  // Validate assistant output parses correctly
  try { JSON.parse(assistant); } catch {
    console.error(`  [${spec.id}] Analysis JSON invalid`);
    return null;
  }

  return { system, user, assistant };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  outputDir: string;
  concurrency: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    outputDir: resolve(process.cwd(), 'output/fine-tuning'),
    concurrency: 3,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--output': args.outputDir = resolve(argv[++i]); break;
      case '--concurrency': args.concurrency = Number(argv[++i]); break;
      case '--dry-run': args.dryRun = true; break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  mkdirSync(args.outputDir, { recursive: true });

  if (args.dryRun) {
    console.log('Dry run — scenarios:');
    const byType: Record<string, number> = {};
    for (const s of SCENARIOS) {
      byType[s.engagementType] = (byType[s.engagementType] ?? 0) + 1;
      console.log(`  ${s.id} [${s.engagementType}] score=${s.targetScore} ${s.polarity}`);
    }
    console.log('\nTotal:', SCENARIOS.length);
    for (const [k, v] of Object.entries(byType)) console.log(`  ${k}: ${v}`);
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey });

  console.log(`Generating ${SCENARIOS.length} synthetic examples (concurrency=${args.concurrency})...`);

  const results: Array<{ system: string; user: string; assistant: string }> = [];
  const failed: string[] = [];

  // Process in batches
  for (let i = 0; i < SCENARIOS.length; i += args.concurrency) {
    const batch = SCENARIOS.slice(i, i + args.concurrency);
    const batchResults = await Promise.all(
      batch.map(async (spec) => {
        process.stdout.write(`  Generating ${spec.id} [${spec.engagementType} score=${spec.targetScore}]...`);
        try {
          const result = await generateOne(client, spec);
          if (result) {
            process.stdout.write(' ✓\n');
            return result;
          } else {
            process.stdout.write(' ✗ (skipped)\n');
            failed.push(spec.id);
            return null;
          }
        } catch (err) {
          process.stdout.write(` ✗ (${(err as Error).message.slice(0, 60)})\n`);
          failed.push(spec.id);
          return null;
        }
      }),
    );
    for (const r of batchResults) if (r) results.push(r);
  }

  console.log(`\nGenerated ${results.length}/${SCENARIOS.length} examples.`);
  if (failed.length > 0) console.log(`Failed: ${failed.join(', ')}`);

  const outPath = resolve(args.outputDir, 'synthetic.jsonl');
  writeFileSync(
    outPath,
    results.map((ex) => JSON.stringify({
      messages: [
        { role: 'system', content: ex.system },
        { role: 'user', content: ex.user },
        { role: 'assistant', content: ex.assistant },
      ],
    })).join('\n') + '\n',
  );
  console.log(`\nWrote ${results.length} examples to: ${outPath}`);
  console.log('\nNext: merge with base dataset:');
  console.log('  npx tsx examples/merge-fine-tuning-datasets.ts');
}

main().catch(console.error);
