import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { gunzipSync } from 'zlib';
import { z } from 'zod';
import type { E2eBenchmarkSuite } from './e2e-benchmark';
import {
  buildPublicDataPipelineSuite,
  PublicDataPipelineSuite,
  PublicDataPipelineSuiteOutput,
  publicDataPipelineSuiteSchema,
  writePublicDataPipelineArtifacts,
} from './public-data-test-pipeline';
import { deriveTranscriptStats } from './transcript-stats';
import type {
  Participant,
  TranscriptInput,
  TranscriptTurn,
} from '../contracts';

const taskmasterUtteranceSchema = z.object({
  index: z.number().int().optional(),
  speaker: z.string().optional(),
  text: z.string().optional(),
});

const taskmasterDialogSchema = z.object({
  conversation_id: z.string().min(1),
  instruction_id: z.string().min(1).optional(),
  utterances: z.array(taskmasterUtteranceSchema).default([]),
});

const abcdConversationSchema = z.object({
  convo_id: z.union([z.string().min(1), z.number().int()]),
  scenario: z.object({
    flow: z.string().min(1).optional(),
    subflow: z.string().min(1).optional(),
  }).passthrough().optional(),
  original: z.array(z.tuple([z.string().min(1), z.string().min(1)])).min(2),
});

const abcdDatasetSchema = z.object({
  train: z.array(abcdConversationSchema),
  dev: z.array(abcdConversationSchema).default([]),
  test: z.array(abcdConversationSchema).default([]),
});

export type TaskmasterDialog = z.infer<typeof taskmasterDialogSchema>;
export type AbcdConversation = z.infer<typeof abcdConversationSchema>;
export type AbcdDataset = z.infer<typeof abcdDatasetSchema>;

export interface BuildPublicScalePipelineSuiteOptions {
  taskmasterDialogs: {
    self: TaskmasterDialog[];
    woz: TaskmasterDialog[];
  };
  abcdDataset: AbcdDataset;
  callLimit?: number;
  ticketLimit?: number;
  emailLimit?: number;
  clock?: () => Date;
}

export interface BuildPublicScaleBenchmarkSuiteConfigOptions {
  scaleManifestPath: string;
  tenantPackPath: string;
  starterManifestPath: string;
  doc2dialManifestPath?: string;
  callcenterenManifestPath?: string;
}

export interface FetchPublicScaleSourceDataOptions {
  cacheDir: string;
}

const TASKMASTER_SELF_DIALOGS_URL = 'https://raw.githubusercontent.com/google-research-datasets/Taskmaster/master/TM-1-2019/self-dialogs.json';
const TASKMASTER_WOZ_DIALOGS_URL = 'https://raw.githubusercontent.com/google-research-datasets/Taskmaster/master/TM-1-2019/woz-dialogs.json';
const ABCD_DATASET_URL = 'https://raw.githubusercontent.com/asappresearch/abcd/master/data/abcd_v1.1.json.gz';

const bucketOrder = ['SHORT', 'MEDIUM', 'LONG', 'VERY_LONG'] as const;

type TranscriptLengthBucket = (typeof bucketOrder)[number];

interface ScaleRecordCandidate<TRecord> {
  record: TRecord;
  transcript: TranscriptInput;
  bucket: TranscriptLengthBucket;
}

interface SyntheticEmailTemplate {
  key: string;
  queue: string;
  subject: string;
  customerBody: string;
  agentBody: string;
  extraDetails: string[];
}

export async function fetchPublicScaleSourceData(
  options: FetchPublicScaleSourceDataOptions,
): Promise<BuildPublicScalePipelineSuiteOptions['taskmasterDialogs'] & { abcdDataset: AbcdDataset }> {
  await mkdir(options.cacheDir, { recursive: true });

  const [taskmasterSelf, taskmasterWoz, abcdDataset] = await Promise.all([
    loadCachedJson(join(options.cacheDir, 'taskmaster-self-dialogs.json'), TASKMASTER_SELF_DIALOGS_URL, taskmasterDialogSchema.array()),
    loadCachedJson(join(options.cacheDir, 'taskmaster-woz-dialogs.json'), TASKMASTER_WOZ_DIALOGS_URL, taskmasterDialogSchema.array()),
    loadCachedGzipJson(join(options.cacheDir, 'abcd-v1.1.json.gz'), ABCD_DATASET_URL, abcdDatasetSchema),
  ]);

  return {
    self: taskmasterSelf,
    woz: taskmasterWoz,
    abcdDataset,
  };
}

export function buildPublicScalePipelineSuite(
  options: BuildPublicScalePipelineSuiteOptions,
): PublicDataPipelineSuite {
  const callLimit = Math.max(1, options.callLimit ?? 20);
  const ticketLimit = Math.max(1, options.ticketLimit ?? 20);
  const emailLimit = Math.max(1, options.emailLimit ?? 20);

  return publicDataPipelineSuiteSchema.parse({
    pipelines: [
      buildTaskmasterCallScalePipeline(options.taskmasterDialogs, callLimit),
      buildAbcdTicketScalePipeline(options.abcdDataset, ticketLimit),
      buildSyntheticSupportEmailScalePipeline(emailLimit),
    ],
  });
}

export function buildPublicScalePipelineSuiteOutput(
  suite: PublicDataPipelineSuite,
  clock: () => Date = () => new Date('2026-03-29T00:00:00.000Z'),
): PublicDataPipelineSuiteOutput {
  return buildPublicDataPipelineSuite(suite, clock);
}

export async function writePublicScalePipelineArtifacts(
  outputDir: string,
  suite: PublicDataPipelineSuite,
): Promise<{
  manifestPath: string;
  summaryPath: string;
  benchmarkArtifacts: Awaited<ReturnType<typeof writePublicDataPipelineArtifacts>>;
}> {
  await mkdir(outputDir, { recursive: true });
  const manifestPath = join(outputDir, 'public-scale-pipeline-suite.json');
  await writeFile(manifestPath, JSON.stringify(suite, null, 2));
  const benchmarkArtifacts = await writePublicDataPipelineArtifacts(
    join(outputDir, 'public-scale-evals'),
    buildPublicScalePipelineSuiteOutput(suite),
  );
  const summaryPath = benchmarkArtifacts.summaryPath;
  return {
    manifestPath,
    summaryPath,
    benchmarkArtifacts,
  };
}

export function buildPublicScaleBenchmarkSuiteConfig(
  options: BuildPublicScaleBenchmarkSuiteConfigOptions,
): E2eBenchmarkSuite {
  const sources: E2eBenchmarkSuite['sources'] = [
    {
      sourceId: 'public-scale-ops',
      kind: 'public_pipeline_suite',
      path: options.scaleManifestPath,
      tenantPackPath: options.tenantPackPath,
    },
    {
      sourceId: 'public-reviewed-starter',
      kind: 'public_pipeline_suite',
      path: options.starterManifestPath,
      tenantPackPath: options.tenantPackPath,
    },
  ];

  if (options.doc2dialManifestPath) {
    sources.push({
      sourceId: 'public-reviewed-doc2dial',
      kind: 'public_pipeline_suite',
      path: options.doc2dialManifestPath,
      tenantPackPath: options.tenantPackPath,
    });
  }

  if (options.callcenterenManifestPath) {
    sources.push({
      sourceId: 'public-reviewed-callcenteren',
      kind: 'public_pipeline_suite',
      path: options.callcenterenManifestPath,
      tenantPackPath: options.tenantPackPath,
    });
  }

  return { sources };
}

function buildTaskmasterCallScalePipeline(
  taskmasterDialogs: BuildPublicScalePipelineSuiteOptions['taskmasterDialogs'],
  limit: number,
) {
  const selfCandidates = taskmasterDialogs.self
    .map((dialog, index) => buildTaskmasterCallCandidate(dialog, index, 'self'))
    .filter(isNonNullable);
  const wozCandidates = taskmasterDialogs.woz
    .map((dialog, index) => buildTaskmasterCallCandidate(dialog, index, 'woz'))
    .filter(isNonNullable);

  const selected = selectRoundRobinByBucket(interleaveCandidates(selfCandidates, wozCandidates), limit);

  return {
    pipelineId: 'support-call-taskmaster-scale',
    tenantId: 'public_eval_scale',
    useCase: 'support',
    dataset: 'TASKMASTER' as const,
    datasetTrack: 'OPEN_CORE' as const,
    engagementType: 'CALL' as const,
    description: 'Large-scale call benchmark slice built from Taskmaster dialogues for operational call throughput and stability checks.',
    notes: [
      'Uses real public dialogues for call-shaped throughput validation.',
      'Leaves sentiment labels unset so the reviewed starter suites remain the accuracy gate.',
    ],
    records: selected.map((candidate) => candidate.record),
  };
}

function buildAbcdTicketScalePipeline(
  dataset: AbcdDataset,
  limit: number,
) {
  const candidates = dataset.train
    .map((conversation, index) => buildAbcdTicketCandidate(conversation, index))
    .filter(isNonNullable);
  const selected = selectRoundRobinByBucket(candidates, limit);

  return {
    pipelineId: 'support-ticket-abcd-scale',
    tenantId: 'public_eval_scale',
    useCase: 'support',
    dataset: 'ABCD' as const,
    datasetTrack: 'OPEN_CORE' as const,
    engagementType: 'TICKET' as const,
    description: 'Large-scale ticket benchmark slice built from ABCD customer-service conversations for async workflow throughput checks.',
    notes: [
      'Uses real public workflow-rich service dialogues for ticket-shaped operational testing.',
      'Leaves sentiment labels unset so ticket accuracy stays anchored to the reviewed public holdout.',
    ],
    records: selected.map((candidate) => candidate.record),
  };
}

function buildSyntheticSupportEmailScalePipeline(limit: number) {
  const templates = buildSyntheticEmailTemplates();
  const candidates = templates
    .flatMap((template, templateIndex) => ['SHORT', 'MEDIUM', 'LONG'].map((bucket, variantIndex) =>
      buildSyntheticEmailCandidate(template, templateIndex, bucket as TranscriptLengthBucket, variantIndex)));
  const selected = selectRoundRobinByBucket(candidates, limit);

  return {
    pipelineId: 'support-email-synthetic-scale',
    tenantId: 'public_eval_scale',
    useCase: 'support',
    dataset: 'SYNTHETIC_TEMPLATE' as const,
    datasetTrack: 'SYNTHETIC' as const,
    engagementType: 'EMAIL' as const,
    description: 'Large-scale support-email benchmark slice generated from deterministic templates because the public-email track remains synthetic.',
    notes: [
      'Provides larger-volume email traffic for latency, failure-rate, and review-rate testing.',
      'Keeps labels unset so accuracy remains measured on the smaller reviewed email holdouts.',
    ],
    records: selected.map((candidate) => candidate.record),
  };
}

function buildTaskmasterCallCandidate(
  dialog: TaskmasterDialog,
  index: number,
  variant: 'self' | 'woz',
): ScaleRecordCandidate<Record<string, unknown>> | null {
  const utterances = dialog.utterances
    .filter((utterance) => (utterance.speaker === 'USER' || utterance.speaker === 'ASSISTANT') && typeof utterance.text === 'string' && utterance.text.trim().length > 0)
    .slice(0, 12);
  if (utterances.length < 4) {
    return null;
  }

  const participants: Participant[] = [
    {
      speakerId: 'customer_1',
      displayName: 'Customer',
      rawRoleLabel: 'customer',
      metadata: {
        channel: 'phone',
      },
    },
    {
      speakerId: 'agent_1',
      displayName: 'Agent',
      rawRoleLabel: 'agent',
      metadata: {
        channel: 'phone',
      },
    },
  ];
  const turns: TranscriptTurn[] = utterances.map((utterance, utteranceIndex) => ({
    turnId: `t${utteranceIndex + 1}`,
    speakerId: utterance.speaker === 'USER' ? 'customer_1' : 'agent_1',
    text: utterance.text?.trim() ?? '',
    startedAt: new Date(Date.UTC(2026, 2, 29, 15, index % 60, utteranceIndex * 5)).toISOString(),
    metadata: {
      sourceSpeaker: utterance.speaker,
      taskmasterVariant: variant,
    },
  }));
  const transcript: TranscriptInput = {
    tenantId: 'public_eval_scale',
    conversationId: dialog.conversation_id,
    useCase: 'support',
    participants,
    turns,
    metadata: {
      queue: 'support_voice',
      engagementType: 'CALL',
      sourceCorpus: 'taskmaster',
      sourceDataset: 'TASKMASTER',
      datasetTrack: 'OPEN_CORE',
      instructionId: dialog.instruction_id ?? null,
      taskmasterVariant: variant,
    },
  };
  const stats = deriveTranscriptStats(transcript);
  if (stats.transcriptCharacterCount < 120 || stats.transcriptCharacterCount > 1600) {
    return null;
  }

  return {
    record: {
      recordId: `taskmaster-${variant}-${String(index + 1).padStart(4, '0')}`,
      conversationId: dialog.conversation_id,
      participants,
      turns,
      labels: {
        canonicalEvents: [],
        tags: ['support', 'call', 'public_scale', `taskmaster_${variant}`],
      },
      metadata: {
        sourceCorpus: 'taskmaster',
        instructionId: dialog.instruction_id ?? null,
        taskmasterVariant: variant,
      },
    },
    transcript,
    bucket: stats.transcriptLengthBucket,
  };
}

function buildAbcdTicketCandidate(
  conversation: AbcdConversation,
  index: number,
): ScaleRecordCandidate<Record<string, unknown>> | null {
  const utterances = conversation.original
    .filter((entry) => entry[1].trim().length > 0)
    .slice(0, 12);
  if (utterances.length < 4) {
    return null;
  }

  const participants: Participant[] = [
    {
      speakerId: 'customer_1',
      displayName: 'Customer',
      rawRoleLabel: 'customer',
      metadata: {
        channel: 'ticket',
      },
    },
    {
      speakerId: 'agent_1',
      displayName: 'Agent',
      rawRoleLabel: 'agent',
      metadata: {
        channel: 'ticket',
      },
    },
  ];
  const comments = utterances.map(([speaker, text], utteranceIndex) => ({
    commentId: `c${utteranceIndex + 1}`,
    authorId: speaker.toLowerCase().includes('agent') ? 'agent_1' : 'customer_1',
    bodyText: text.trim(),
    createdAt: new Date(Date.UTC(2026, 2, 29, 16, index % 60, utteranceIndex * 5)).toISOString(),
    metadata: {
      originalSpeaker: speaker,
      flow: conversation.scenario?.flow ?? null,
      subflow: conversation.scenario?.subflow ?? null,
    },
  }));
  const transcript: TranscriptInput = {
    tenantId: 'public_eval_scale',
    conversationId: `abcd_${conversation.convo_id}`,
    useCase: 'support',
    participants,
    turns: comments.map((comment, commentIndex) => ({
      turnId: `c${commentIndex + 1}`,
      speakerId: comment.authorId,
      text: comment.bodyText,
      startedAt: comment.createdAt,
      endedAt: comment.createdAt,
      metadata: comment.metadata,
    })),
    metadata: {
      queue: 'support_async',
      engagementType: 'TICKET',
      sourceCorpus: 'abcd',
      sourceDataset: 'ABCD',
      datasetTrack: 'OPEN_CORE',
      flow: conversation.scenario?.flow ?? null,
      subflow: conversation.scenario?.subflow ?? null,
    },
  };
  const stats = deriveTranscriptStats(transcript);
  if (stats.transcriptCharacterCount < 120 || stats.transcriptCharacterCount > 1800) {
    return null;
  }

  const flow = conversation.scenario?.flow ?? 'support';
  const subflow = conversation.scenario?.subflow ?? 'general';

  return {
    record: {
      recordId: `abcd-scale-${String(index + 1).padStart(4, '0')}`,
      ticketId: `abcd_ticket_${conversation.convo_id}`,
      title: `${flow.replace(/_/g, ' ')} / ${subflow.replace(/_/g, ' ')}`,
      participants,
      comments,
      labels: {
        canonicalEvents: [],
        tags: ['support', 'ticket', 'public_scale', flow, subflow],
      },
      metadata: {
        sourceCorpus: 'abcd',
        flow,
        subflow,
      },
    },
    transcript,
    bucket: stats.transcriptLengthBucket,
  };
}

function buildSyntheticEmailCandidate(
  template: SyntheticEmailTemplate,
  templateIndex: number,
  bucket: TranscriptLengthBucket,
  variantIndex: number,
): ScaleRecordCandidate<Record<string, unknown>> {
  const extraDetail = buildEmailDetailBlock(template.extraDetails, bucket, variantIndex);
  const customerMessage = [template.customerBody, extraDetail].filter(Boolean).join('\n\n');
  const agentMessage = [template.agentBody, bucket === 'LONG' ? buildLongAgentFooter(template.key) : ''].filter(Boolean).join('\n\n');
  const participants: Participant[] = [
    {
      speakerId: 'customer_1',
      displayName: 'Customer',
      rawRoleLabel: 'customer',
      metadata: {
        channel: 'email',
      },
    },
    {
      speakerId: 'agent_1',
      displayName: 'Support Agent',
      rawRoleLabel: 'agent',
      metadata: {
        channel: 'email',
      },
    },
  ];
  const messages = [
    {
      messageId: 'm1',
      senderId: 'customer_1',
      subject: template.subject,
      bodyText: customerMessage,
      sentAt: new Date(Date.UTC(2026, 2, 29, 17, templateIndex, variantIndex * 7)).toISOString(),
      metadata: {
        queue: template.queue,
        variant: bucket,
      },
    },
    {
      messageId: 'm2',
      senderId: 'agent_1',
      subject: template.subject,
      bodyText: agentMessage,
      sentAt: new Date(Date.UTC(2026, 2, 29, 17, templateIndex, variantIndex * 7 + 3)).toISOString(),
      metadata: {
        queue: template.queue,
        variant: bucket,
      },
    },
  ];
  const transcript: TranscriptInput = {
    tenantId: 'public_eval_scale',
    conversationId: `support_email_scale_${template.key}_${bucket.toLowerCase()}_${variantIndex + 1}`,
    useCase: 'support',
    participants,
    turns: messages.map((message, messageIndex) => ({
      turnId: `m${messageIndex + 1}`,
      speakerId: message.senderId,
      text: `Subject: ${template.subject}\n\n${message.bodyText}`,
      startedAt: message.sentAt,
      endedAt: message.sentAt,
      metadata: message.metadata,
    })),
    metadata: {
      queue: template.queue,
      engagementType: 'EMAIL',
      sourceCorpus: 'synthetic_template',
      sourceDataset: 'SYNTHETIC_TEMPLATE',
      datasetTrack: 'SYNTHETIC',
      templateKey: template.key,
      transcriptVariant: bucket,
    },
  };
  const stats = deriveTranscriptStats(transcript);

  return {
    record: {
      recordId: `support-email-scale-${template.key}-${bucket.toLowerCase()}-${variantIndex + 1}`,
      threadId: `support_email_scale_${template.key}_${variantIndex + 1}`,
      subject: template.subject,
      participants,
      messages,
      labels: {
        canonicalEvents: [],
        tags: ['support', 'email', 'public_scale', template.key, bucket.toLowerCase()],
      },
      metadata: {
        sourceCorpus: 'synthetic_template',
        queue: template.queue,
        templateKey: template.key,
        bucket: bucket.toLowerCase(),
        transcriptLengthBucket: stats.transcriptLengthBucket,
      },
    },
    transcript,
    bucket: stats.transcriptLengthBucket,
  };
}

function buildSyntheticEmailTemplates(): SyntheticEmailTemplate[] {
  return [
    {
      key: 'missed_commitment',
      queue: 'support_email',
      subject: 'Order update still missing after promised follow-up',
      customerBody: 'You said the replacement tracking link would be in my inbox yesterday, and I am still waiting for anything concrete.',
      agentBody: 'I escalated the replacement request, confirmed the shipment handoff, and will send the tracking details as soon as the carrier posts them.',
      extraDetails: [
        'I have already checked the spam folder, the portal, and the original case thread.',
        'This delay matters because the original item failed during a live rollout and the backup stock is already committed elsewhere.',
        'If the handoff slips again, I need a written summary of what blocked the shipment and the next accountable owner.',
      ],
    },
    {
      key: 'configuration_gap',
      queue: 'support_email_priority',
      subject: 'Setup article still does not match our account menus',
      customerBody: 'The article and screenshots still point to settings that do not exist for our account tier, so the import path keeps failing halfway through.',
      agentBody: 'I rebuilt the steps against your environment, attached updated screenshots, and asked onboarding to verify the corrected path.',
      extraDetails: [
        'We retried the same flow twice this morning with an admin on the call, and the documented sequence never matched the live menus.',
        'The mismatch is now blocking training for the rest of the team because we cannot publish the internal runbook until the screenshots are correct.',
        'Please include which role or entitlement changed the menu path so we can update our internal checklist without another round trip.',
      ],
    },
    {
      key: 'outage_summary',
      queue: 'support_email_escalations',
      subject: 'Need written outage summary before customer relaunch',
      customerBody: 'Each promised update window has passed without a clear root-cause note, and leadership is asking for a written status before we reopen service externally.',
      agentBody: 'I escalated this to incident command, attached the current mitigation notes, and set the next written update for 2 PM local time.',
      extraDetails: [
        'We need to understand what failed, what is currently stable, and what remains degraded because the external status page is no longer enough for our escalation path.',
        'Finance and operations are both asking whether the same failure mode can recur during the next reconciliation window.',
        'If the service is still unstable, call that out directly so we can delay the relaunch decision instead of discovering it from another missed milestone.',
      ],
    },
    {
      key: 'positive_resolution',
      queue: 'support_email',
      subject: 'Configuration issue resolved after detailed follow-up',
      customerBody: 'The detailed screenshots finally matched our environment, the import completed cleanly, and the team can move forward again.',
      agentBody: 'Thank you for confirming. I documented the corrected flow so the next customer on this path gets the right instructions immediately.',
      extraDetails: [
        'The revised steps were precise enough that a second admin could follow them without additional help.',
        'We have already added the corrected screenshots to our internal checklist and no longer need the earlier workaround.',
        'Please keep the updated article linked to the same case so our rollout manager can reference it during next week\'s deployment review.',
      ],
    },
    {
      key: 'attachment_missing',
      queue: 'support_email_priority',
      subject: 'Return label message arrived without the file again',
      customerBody: 'The replacement label email came through again without any attachment, so I still cannot send the defective unit back.',
      agentBody: 'I resent the label from a different workflow, verified the attachment is present, and escalated the original delivery failure to shipping operations.',
      extraDetails: [
        'This is the second missed attempt, and the return clock is still running while the defective device remains in our staging room.',
        'If the label fails one more time, we need an alternate return path that does not depend on the original email workflow.',
        'Please confirm whether the label is attached as a PDF or embedded link because our mail gateway strips some attachment types automatically.',
      ],
    },
    {
      key: 'billing_correction',
      queue: 'support_email',
      subject: 'Billing correction confirmed after duplicate charge removal',
      customerBody: 'Thanks for removing the duplicate charge and sending the revised invoice so quickly.',
      agentBody: 'Glad that fixed it. I also added a monitor on the account so the duplicate billing path does not recur next cycle.',
      extraDetails: [
        'The revised invoice now matches the original statement of work and the finance approver has already cleared it for payment.',
        'We only needed the corrected invoice number and confirmation that the credit memo would settle in the same cycle.',
        'If another discrepancy shows up next month, we will reference this correction path because it was easy for the team to follow.',
      ],
    },
    {
      key: 'documentation_conflict',
      queue: 'support_email_escalations',
      subject: 'Published policy still conflicts with what support is enforcing',
      customerBody: 'The portal says one thing, the latest agent told us another, and we still do not know which rule actually governs the request.',
      agentBody: 'I raised the documentation conflict with product operations and asked policy owners to confirm the authoritative rule in writing.',
      extraDetails: [
        'The contradiction is now creating approval delays because each stakeholder is citing a different copy of the same policy.',
        'Please call out whether the published article is wrong or whether the internal override is temporary, because those lead to different downstream actions for us.',
        'We also need to know which cases are already affected so the current queue can be corrected without waiting for another audit cycle.',
      ],
    },
    {
      key: 'priority_escalation',
      queue: 'support_email_escalations',
      subject: 'Executive escalation still needs accountable timeline',
      customerBody: 'We appreciate the quick response, but the executive team still needs a named owner and a real timeline instead of another general update.',
      agentBody: 'I assigned an incident owner, documented the escalation path, and will send the accountable timeline after the next coordination checkpoint.',
      extraDetails: [
        'The last two updates explained effort but not ownership, which made it difficult for leadership to decide whether to keep resources committed.',
        'If the next checkpoint changes the timeline again, include the blocker explicitly so we do not keep translating vague updates for the stakeholders.',
        'This is now visible to procurement and the shared-services team, so we need language that stands on its own without another interpretation round.',
      ],
    },
  ];
}


function isNonNullable<T>(value: T | null | undefined): value is T {
  return value != null;
}

function buildEmailDetailBlock(details: string[], bucket: TranscriptLengthBucket, variantIndex: number): string {
  if (bucket === 'SHORT') {
    return details[variantIndex % details.length] ?? '';
  }
  if (bucket === 'MEDIUM') {
    return details.slice(0, 2).join(' ');
  }
  return details.join(' ');
}

function buildLongAgentFooter(templateKey: string): string {
  return `For tracking: this thread is tagged ${templateKey}, the queue owner has been updated, and the next written checkpoint will include any dependency that could change the promised path.`;
}

function interleaveCandidates<T>(left: T[], right: T[]): T[] {
  const interleaved: T[] = [];
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (left[index]) {
      interleaved.push(left[index]);
    }
    if (right[index]) {
      interleaved.push(right[index]);
    }
  }
  return interleaved;
}

function selectRoundRobinByBucket<T>(candidates: Array<ScaleRecordCandidate<T>>, limit: number): Array<ScaleRecordCandidate<T>> {
  const groups = new Map<TranscriptLengthBucket, Array<ScaleRecordCandidate<T>>>();
  for (const bucket of bucketOrder) {
    groups.set(bucket, []);
  }
  for (const candidate of candidates) {
    groups.get(candidate.bucket)?.push(candidate);
  }

  const selected: Array<ScaleRecordCandidate<T>> = [];
  while (selected.length < limit) {
    let progressed = false;
    for (const bucket of bucketOrder) {
      const group = groups.get(bucket);
      if (group && group.length > 0 && selected.length < limit) {
        selected.push(group.shift()!);
        progressed = true;
      }
    }

    if (!progressed) {
      break;
    }
  }

  return selected;
}

async function loadCachedJson<T>(cachePath: string, url: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await loadCachedBytes(cachePath, url);
  return schema.parse(JSON.parse(raw.toString('utf8')));
}

async function loadCachedGzipJson<T>(cachePath: string, url: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await loadCachedBytes(cachePath, url);
  return schema.parse(JSON.parse(gunzipSync(raw).toString('utf8')));
}

async function loadCachedBytes(cachePath: string, url: string): Promise<Buffer> {
  try {
    return await readFile(cachePath);
  } catch {}

  const response = await fetch(url, {
    headers: {
      'user-agent': 'conversation-intelligence-public-scale-benchmark',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, bytes);
  return bytes;
}
