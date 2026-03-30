function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RunConsoleOptions {
  title?: string;
}

export function renderRunConsoleHtml(options: RunConsoleOptions = {}): string {
  const title = options.title ?? 'Conversation Intelligence Console';
  const escapedTitle = escapeHtml(title);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapedTitle}</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0f172a;
        color: #e2e8f0;
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: #020617; color: #e2e8f0; }
      header {
        display: flex;
        gap: 16px;
        justify-content: space-between;
        align-items: center;
        padding: 16px 20px;
        border-bottom: 1px solid #1e293b;
        background: #0f172a;
        position: sticky;
        top: 0;
      }
      h1 { margin: 0; font-size: 20px; }
      main {
        display: grid;
        grid-template-columns: minmax(300px, 360px) minmax(360px, 1fr) minmax(280px, 340px);
        gap: 16px;
        padding: 16px;
        min-height: calc(100vh - 74px);
      }
      section, aside {
        background: #0f172a;
        border: 1px solid #1e293b;
        border-radius: 12px;
        padding: 16px;
        min-height: 240px;
      }
      .panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
      }
      .panel-header h2 {
        margin: 0;
        font-size: 16px;
      }
      .stack { display: flex; flex-direction: column; gap: 12px; }
      .controls {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      input, button, select {
        border-radius: 8px;
        border: 1px solid #334155;
        background: #020617;
        color: #e2e8f0;
        padding: 10px 12px;
        font: inherit;
      }
      textarea {
        width: 100%;
        min-height: 88px;
        border-radius: 8px;
        border: 1px solid #334155;
        background: #020617;
        color: #e2e8f0;
        padding: 10px 12px;
        font: inherit;
        resize: vertical;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
      }
      input { min-width: 240px; }
      button {
        cursor: pointer;
        background: #1d4ed8;
        border-color: #1d4ed8;
      }
      button.secondary {
        background: transparent;
        border-color: #334155;
      }
      .status {
        color: #93c5fd;
        font-size: 13px;
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .card {
        padding: 12px;
        border: 1px solid #1e293b;
        border-radius: 10px;
        background: #020617;
      }
      .card.active {
        border-color: #60a5fa;
        box-shadow: inset 0 0 0 1px #60a5fa;
      }
      .card button {
        all: unset;
        display: block;
        width: 100%;
        cursor: pointer;
      }
      .muted {
        color: #94a3b8;
        font-size: 13px;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        word-break: break-all;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 88px;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .badge.queued { background: #1e3a8a; }
      .badge.running { background: #92400e; }
      .badge.completed { background: #166534; }
      .badge.failed { background: #991b1b; }
      .badge.review { background: #7c3aed; }
      .badge.info { background: #334155; }
      .badge.warning { background: #92400e; }
      .badge.critical { background: #991b1b; }
      dl {
        display: grid;
        grid-template-columns: 120px 1fr;
        gap: 8px 12px;
        margin: 0;
      }
      dt { color: #94a3b8; }
      dd { margin: 0; }
      .empty {
        border: 1px dashed #334155;
        border-radius: 10px;
        padding: 16px;
        color: #94a3b8;
      }
      .action-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 12px;
      }
      @media (max-width: 1100px) {
        main {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>${escapedTitle}</h1>
        <div class="muted">Self-hosted run visibility backed by persisted run events.</div>
      </div>
      <div class="controls">
        <input id="api-key" type="password" placeholder="Optional API key for Bearer auth" />
        <button id="apply-api-key" class="secondary" type="button">Apply key</button>
        <button id="refresh" type="button">Refresh</button>
      </div>
    </header>
    <main>
      <aside class="stack">
        <div class="panel-header">
          <h2>Runs</h2>
          <span id="run-count" class="muted"></span>
        </div>
        <div id="run-status" class="status">Loading runs...</div>
        <div class="controls">
          <input id="run-search" type="text" placeholder="Filter runs by ID, tenant, or conversation" />
          <select id="run-status-filter">
            <option value="all">All statuses</option>
            <option value="QUEUED">Queued</option>
            <option value="RUNNING">Running</option>
            <option value="COMPLETED">Completed</option>
            <option value="FAILED">Failed</option>
          </select>
        </div>
        <ul id="runs" class="list"></ul>
      </aside>
      <section class="stack">
        <div class="panel-header">
          <h2>Selected Run</h2>
          <span id="run-live-state" class="muted">Idle</span>
        </div>
        <div id="run-detail" class="empty">Select a run to inspect its lifecycle and review state.</div>
        <div class="panel-header">
          <h2>Run Events</h2>
          <span id="event-count" class="muted"></span>
        </div>
        <ul id="events" class="list"></ul>
        <div class="panel-header">
          <h2>Audit Events</h2>
          <span id="audit-count" class="muted"></span>
        </div>
        <ul id="audit-events" class="list"></ul>
      </section>
      <aside class="stack">
        <div class="panel-header">
          <h2>Review Queue</h2>
          <span id="review-count" class="muted"></span>
        </div>
        <div class="controls">
          <input id="review-search" type="text" placeholder="Filter review items by run ID or reason" />
          <select id="review-assignment-filter">
            <option value="all">All review items</option>
            <option value="unassigned">Unassigned only</option>
            <option value="assigned">Assigned only</option>
          </select>
        </div>
        <div id="review-analytics" class="card"></div>
        <textarea id="bulk-review-note" placeholder="Optional note for bulk review actions"></textarea>
        <div class="action-row">
          <button id="bulk-select-visible" class="secondary" type="button">Select Visible</button>
          <button id="bulk-clear-selection" class="secondary" type="button">Clear Selection</button>
          <button id="bulk-assign" class="secondary" type="button">Bulk Assign</button>
          <button id="bulk-verify" type="button">Bulk Verify</button>
          <button id="bulk-mark-uncertain" class="secondary" type="button">Bulk Uncertain</button>
          <button id="bulk-keep-review" class="secondary" type="button">Bulk Keep Review</button>
        </div>
        <ul id="review-queue" class="list"></ul>
        <div class="panel-header">
          <h2>Tenant Packs</h2>
          <span id="tenant-pack-status" class="muted">Idle</span>
        </div>
        <input id="tenant-pack-tenant-id" type="text" placeholder="Tenant ID (optional with tenant-scoped auth)" />
        <input id="tenant-pack-use-case" type="text" value="support" placeholder="Use case" />
        <input id="tenant-pack-target-version" type="text" placeholder="Target version for approve, promote, or rollback" />
        <input id="tenant-pack-approvals-required" type="number" min="1" value="1" placeholder="Approvals required" />
        <input id="tenant-pack-canary-percentage" type="number" min="1" max="100" value="10" placeholder="Canary percentage" />
        <textarea id="tenant-pack-note" placeholder="Optional release note or comment"></textarea>
        <div class="controls">
          <input id="tenant-pack-canary-sample-size" type="number" min="0" value="25" placeholder="Canary sample size" />
          <input id="tenant-pack-canary-failure-rate" type="number" min="0" max="100" value="5" placeholder="Failure rate %" />
          <input id="tenant-pack-canary-review-rate" type="number" min="0" max="100" value="20" placeholder="Review rate %" />
          <input id="tenant-pack-canary-uncertain-rate" type="number" min="0" max="100" value="5" placeholder="Uncertain rate %" />
          <input id="tenant-pack-canary-average-score" type="number" min="0" max="100" value="60" placeholder="Average score /100" />
          <label class="muted"><input id="tenant-pack-canary-apply" type="checkbox" /> auto-apply</label>
        </div>
        <textarea id="tenant-pack-editor" placeholder="Paste a tenant pack draft JSON document here"></textarea>
        <div class="action-row">
          <button id="tenant-pack-load" class="secondary" type="button">Load Active</button>
          <button id="tenant-pack-validate" class="secondary" type="button">Validate</button>
          <button id="tenant-pack-preview" class="secondary" type="button">Preview</button>
          <button id="tenant-pack-publish" type="button">Publish Direct</button>
          <button id="tenant-pack-publish-approval" class="secondary" type="button">Publish Approval</button>
          <button id="tenant-pack-publish-canary" class="secondary" type="button">Publish Canary</button>
          <button id="tenant-pack-approve" class="secondary" type="button">Approve Target</button>
          <button id="tenant-pack-comment" class="secondary" type="button">Add Comment</button>
          <button id="tenant-pack-evaluate-canary" class="secondary" type="button">Evaluate Canary</button>
          <button id="tenant-pack-promote" class="secondary" type="button">Promote Canary</button>
          <button id="tenant-pack-fail-canary" class="secondary" type="button">Fail Canary</button>
          <button id="tenant-pack-rollback" class="secondary" type="button">Rollback</button>
        </div>
        <pre id="tenant-pack-output" class="card muted">No tenant pack loaded.</pre>
        <ul id="tenant-pack-releases" class="list"></ul>
        <ul id="tenant-pack-history" class="list"></ul>
        <div class="panel-header">
          <h2>Model Validation</h2>
          <span id="validation-status" class="muted">Idle</span>
        </div>
        <div class="action-row">
          <button id="validation-refresh" class="secondary" type="button">Load Validation</button>
          <button id="validation-refresh-exports" class="secondary" type="button">Refresh Exports</button>
          <button id="validation-recommend" class="secondary" type="button">Recommend Thresholds</button>
          <button id="validation-run" type="button">Run Validation</button>
        </div>
        <pre id="validation-summary" class="card muted">No validation report loaded.</pre>
        <ul id="validation-datasets" class="list"></ul>
        <ul id="validation-breakdowns" class="list"></ul>
        <ul id="validation-reports" class="list"></ul>
        <ul id="validation-alerts" class="list"></ul>
      </aside>
    </main>
    <script>
      (() => {
        const state = {
          apiKey: localStorage.getItem('ci-console-api-key') || '',
          runs: [],
          selectedRunId: null,
          selectedRun: null,
          events: [],
          auditEvents: [],
          reviewItems: [],
          reviewAnalytics: null,
          tenantPackState: null,
          tenantPackOutput: null,
          selectedPackVersion: null,
          validationDatasets: [],
          validationReports: [],
          validationAlerts: [],
          validationOutput: null,
          selectedReviewIds: new Set(),
          eventSource: null,
          pollTimer: null,
          reviewActionPending: false,
        };

        const eventTypes = [
          'RUN_CREATED',
          'PII_MASKED',
          'RUN_CLAIMED',
          'LLM_STARTED',
          'LLM_COMPLETED',
          'REVIEW_REQUIRED',
          'ANALYST_ASSIGNED',
          'ANALYST_COMMENT_ADDED',
          'ANALYST_REVIEW_RECORDED',
          'RUN_COMPLETED',
          'RUN_FAILED',
        ];

        const dom = {
          apiKey: document.getElementById('api-key'),
          applyApiKey: document.getElementById('apply-api-key'),
          refresh: document.getElementById('refresh'),
          runCount: document.getElementById('run-count'),
          runStatus: document.getElementById('run-status'),
          runSearch: document.getElementById('run-search'),
          runStatusFilter: document.getElementById('run-status-filter'),
          runs: document.getElementById('runs'),
          runDetail: document.getElementById('run-detail'),
          runLiveState: document.getElementById('run-live-state'),
          eventCount: document.getElementById('event-count'),
          events: document.getElementById('events'),
          auditCount: document.getElementById('audit-count'),
          auditEvents: document.getElementById('audit-events'),
          reviewCount: document.getElementById('review-count'),
          reviewSearch: document.getElementById('review-search'),
          reviewAssignmentFilter: document.getElementById('review-assignment-filter'),
          reviewAnalytics: document.getElementById('review-analytics'),
          bulkReviewNote: document.getElementById('bulk-review-note'),
          bulkSelectVisible: document.getElementById('bulk-select-visible'),
          bulkClearSelection: document.getElementById('bulk-clear-selection'),
          bulkAssign: document.getElementById('bulk-assign'),
          bulkVerify: document.getElementById('bulk-verify'),
          bulkMarkUncertain: document.getElementById('bulk-mark-uncertain'),
          bulkKeepReview: document.getElementById('bulk-keep-review'),
          reviewQueue: document.getElementById('review-queue'),
          tenantPackStatus: document.getElementById('tenant-pack-status'),
          tenantPackTenantId: document.getElementById('tenant-pack-tenant-id'),
          tenantPackUseCase: document.getElementById('tenant-pack-use-case'),
          tenantPackTargetVersion: document.getElementById('tenant-pack-target-version'),
          tenantPackApprovalsRequired: document.getElementById('tenant-pack-approvals-required'),
          tenantPackCanaryPercentage: document.getElementById('tenant-pack-canary-percentage'),
          tenantPackNote: document.getElementById('tenant-pack-note'),
          tenantPackCanarySampleSize: document.getElementById('tenant-pack-canary-sample-size'),
          tenantPackCanaryFailureRate: document.getElementById('tenant-pack-canary-failure-rate'),
          tenantPackCanaryReviewRate: document.getElementById('tenant-pack-canary-review-rate'),
          tenantPackCanaryUncertainRate: document.getElementById('tenant-pack-canary-uncertain-rate'),
          tenantPackCanaryAverageScore: document.getElementById('tenant-pack-canary-average-score'),
          tenantPackCanaryApply: document.getElementById('tenant-pack-canary-apply'),
          tenantPackEditor: document.getElementById('tenant-pack-editor'),
          tenantPackLoad: document.getElementById('tenant-pack-load'),
          tenantPackValidate: document.getElementById('tenant-pack-validate'),
          tenantPackPreview: document.getElementById('tenant-pack-preview'),
          tenantPackPublish: document.getElementById('tenant-pack-publish'),
          tenantPackPublishApproval: document.getElementById('tenant-pack-publish-approval'),
          tenantPackPublishCanary: document.getElementById('tenant-pack-publish-canary'),
          tenantPackApprove: document.getElementById('tenant-pack-approve'),
          tenantPackComment: document.getElementById('tenant-pack-comment'),
          tenantPackEvaluateCanary: document.getElementById('tenant-pack-evaluate-canary'),
          tenantPackPromote: document.getElementById('tenant-pack-promote'),
          tenantPackFailCanary: document.getElementById('tenant-pack-fail-canary'),
          tenantPackRollback: document.getElementById('tenant-pack-rollback'),
          tenantPackOutput: document.getElementById('tenant-pack-output'),
          tenantPackReleases: document.getElementById('tenant-pack-releases'),
          tenantPackHistory: document.getElementById('tenant-pack-history'),
          validationStatus: document.getElementById('validation-status'),
          validationRefresh: document.getElementById('validation-refresh'),
          validationRefreshExports: document.getElementById('validation-refresh-exports'),
          validationRecommend: document.getElementById('validation-recommend'),
          validationRun: document.getElementById('validation-run'),
          validationSummary: document.getElementById('validation-summary'),
          validationDatasets: document.getElementById('validation-datasets'),
          validationBreakdowns: document.getElementById('validation-breakdowns'),
          validationReports: document.getElementById('validation-reports'),
          validationAlerts: document.getElementById('validation-alerts'),
        };

        dom.apiKey.value = state.apiKey;

        function authorizationHeaders() {
          return state.apiKey ? { authorization: 'Bearer ' + state.apiKey } : {};
        }

        async function api(path, init = {}) {
          const response = await fetch(path, {
            ...init,
            headers: {
              ...authorizationHeaders(),
              ...(init.headers || {}),
            },
          });

          if (!response.ok) {
            let message = 'Request failed';
            try {
              const body = await response.json();
              message = body.error || message;
            } catch (error) {
              message = response.status + ' ' + response.statusText;
            }
            throw new Error(message);
          }

          return response.json();
        }

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }

        function badgeClass(status) {
          const normalized = String(status || '').toLowerCase();
          if (normalized === 'needs_review') {
            return 'review';
          }
          return normalized;
        }

        function prettyJson(value) {
          return JSON.stringify(value, null, 2);
        }

        function minutesSince(timestamp) {
          const millis = Date.parse(timestamp || '');
          if (!Number.isFinite(millis)) {
            return 0;
          }
          return Math.max(0, Math.floor((Date.now() - millis) / 60000));
        }

        function formatAge(minutes) {
          if (minutes < 60) {
            return minutes + 'm';
          }
          const hours = Math.floor(minutes / 60);
          const remainder = minutes % 60;
          return hours + 'h ' + remainder + 'm';
        }

        function reviewSlaTargets() {
          return state.reviewAnalytics && state.reviewAnalytics.sla
            ? state.reviewAnalytics.sla
            : {
              pendingTargetMinutes: 60,
              assignedTargetMinutes: 30,
            };
        }

        function reviewSlaSummary(item) {
          const targets = item && item.policy ? item.policy : reviewSlaTargets();
          const assignedAt = item.review && item.review.assignment ? item.review.assignment.assignedAt : null;
          const ageMinutes = minutesSince(assignedAt || item.createdAt);
          const targetMinutes = assignedAt ? targets.assignedTargetMinutes : targets.pendingTargetMinutes;
          return {
            ageMinutes,
            overdue: ageMinutes >= targetMinutes,
            targetMinutes,
          };
        }

        function renderRuns() {
          const search = dom.runSearch.value.trim().toLowerCase();
          const statusFilter = dom.runStatusFilter.value;
          const runs = state.runs.filter((run) => {
            const haystack = [run.jobId, run.tenantId, run.conversationId || '', run.useCase || '']
              .join(' ')
              .toLowerCase();
            const searchMatch = !search || haystack.includes(search);
            const statusMatch = statusFilter === 'all' || run.status === statusFilter;
            return searchMatch && statusMatch;
          });

          dom.runCount.textContent = runs.length + ' visible / ' + state.runs.length + ' total';
          dom.runs.innerHTML = '';

          if (!runs.length) {
            dom.runs.innerHTML = '<li class="empty">No runs found for the current auth scope.</li>';
            return;
          }

          runs.forEach((run) => {
            const item = document.createElement('li');
            const activeClass = run.jobId === state.selectedRunId ? 'active' : '';
            item.className = 'card ' + activeClass;
            item.innerHTML = [
              '<button type="button">',
              '<div class="panel-header">',
              '<strong class="mono">' + escapeHtml(run.jobId) + '</strong>',
              '<span class="badge ' + badgeClass(run.status) + '">' + escapeHtml(run.status) + '</span>',
              '</div>',
              '<div class="muted">Tenant: ' + escapeHtml(run.tenantId) + '</div>',
              '<div class="muted">Conversation: ' + escapeHtml(run.conversationId || 'n/a') + '</div>',
              '<div class="muted">Updated: ' + escapeHtml(run.updatedAt) + '</div>',
              '</button>',
            ].join('');
            item.querySelector('button').addEventListener('click', () => selectRun(run.jobId));
            dom.runs.appendChild(item);
          });
        }

        function renderSelectedRun() {
          if (!state.selectedRun) {
            dom.runDetail.innerHTML = 'Select a run to inspect its lifecycle and review state.';
            return;
          }

          const run = state.selectedRun;
          syncTenantPackScopeFromRun(run);
          const reviewState = run.result && run.result.review ? run.result.review.state : 'n/a';
          const reviewReasons = run.result && run.result.review ? run.result.review.reasons.join(', ') : '';
          const summary = run.result ? run.result.summary : run.error ? run.error.message : 'Pending';
          const overallSentiment = run.result ? run.result.overallEndUserSentiment : null;
          const sentimentText = overallSentiment
            ? [overallSentiment.polarity, 'intensity ' + overallSentiment.intensity, 'confidence ' + overallSentiment.confidence]
              .join(' | ')
            : 'None';
          const sentimentScoreText = overallSentiment && overallSentiment.score
            ? overallSentiment.score.score5 + '/5 (' + overallSentiment.score.score100 + '/100)'
            : 'None';
          const resolution = run.result && run.result.review ? run.result.review.resolution : null;
          const resolutionText = resolution
            ? [resolution.resultingState, resolution.actorId, resolution.decidedAt, resolution.note || '']
              .filter(Boolean)
              .join(' | ')
            : 'None';
          const assignment = run.result && run.result.review ? run.result.review.assignment : null;
          const assignmentText = assignment
            ? [assignment.assigneeId, assignment.assignedAt, assignment.note || '']
              .filter(Boolean)
              .join(' | ')
            : 'Unassigned';
          const reviewTiming = reviewSlaSummary({
            createdAt: run.createdAt,
            review: run.result && run.result.review ? run.result.review : {},
          });
          const reviewAgeText = formatAge(reviewTiming.ageMinutes) + ' / target ' + formatAge(reviewTiming.targetMinutes);
          const comments = run.result && run.result.review && Array.isArray(run.result.review.comments)
            ? run.result.review.comments.slice().reverse().slice(0, 6)
            : [];
          const commentsMarkup = comments.length
            ? '<div class="stack"><div class="panel-header"><h2>Analyst Comments</h2><span class="muted">Latest ' + escapeHtml(String(comments.length)) + '</span></div><ul class="list">'
              + comments.map((comment) => [
                '<li class="card">',
                '<div class="panel-header"><strong>' + escapeHtml(comment.actorId) + '</strong><span class="muted">' + escapeHtml(comment.createdAt) + '</span></div>',
                '<div>' + escapeHtml(comment.text) + '</div>',
                '</li>',
              ].join('')).join('')
              + '</ul></div>'
            : '<div class="muted">No analyst comments.</div>';
          const historyEntries = run.result && run.result.review && Array.isArray(run.result.review.history)
            ? run.result.review.history.slice().reverse().slice(0, 5)
            : [];
          const historyMarkup = historyEntries.length
            ? '<div class="stack"><div class="panel-header"><h2>Analyst History</h2><span class="muted">Latest 5</span></div><ul class="list">'
              + historyEntries.map((entry) => [
                '<li class="card">',
                '<div class="panel-header"><strong>' + escapeHtml(entry.kind) + '</strong><span class="muted">' + escapeHtml(entry.actedAt) + '</span></div>',
                '<div class="muted">' + escapeHtml(entry.actorId) + ' / ' + escapeHtml(entry.actorType) + '</div>',
                '<div class="muted">' + escapeHtml([entry.assigneeId || '', entry.decision || '', entry.resultingState || '', entry.note || ''].filter(Boolean).join(' | ') || 'No detail') + '</div>',
                '</li>',
              ].join('')).join('')
              + '</ul></div>'
            : '<div class="muted">No analyst history.</div>';
          const reviewActions = run.status === 'COMPLETED'
            ? [
              '<div class="stack">',
              '<div class="panel-header"><h2>Analyst Action</h2><span class="muted">' + (state.reviewActionPending ? 'Submitting' : 'Ready') + '</span></div>',
              '<textarea id="review-note" placeholder="Optional analyst note"></textarea>',
              '<div class="action-row">',
              '<button type="button" data-review-action="ASSIGN_TO_ME" class="secondary">Assign To Me</button>',
              '<button type="button" data-review-action="ADD_COMMENT" class="secondary">Add Comment</button>',
              '<button type="button" data-review-action="VERIFY">Verify</button>',
              '<button type="button" data-review-action="MARK_UNCERTAIN" class="secondary">Mark Uncertain</button>',
              '<button type="button" data-review-action="KEEP_NEEDS_REVIEW" class="secondary">Keep In Review</button>',
              '</div>',
              '</div>',
            ].join('')
            : '';

          dom.runDetail.className = 'card';
          dom.runDetail.innerHTML = [
            '<div class="panel-header">',
            '<strong class="mono">' + escapeHtml(run.jobId) + '</strong>',
            '<span class="badge ' + badgeClass(run.status) + '">' + escapeHtml(run.status) + '</span>',
            '</div>',
            '<dl>',
            '<dt>Tenant</dt><dd>' + escapeHtml(run.tenantId) + '</dd>',
            '<dt>Conversation</dt><dd>' + escapeHtml(run.conversationId || 'n/a') + '</dd>',
            '<dt>Use Case</dt><dd>' + escapeHtml(run.useCase) + '</dd>',
            '<dt>Review</dt><dd><span class="badge ' + badgeClass(reviewState) + '">' + escapeHtml(reviewState) + '</span></dd>',
            '<dt>Reasons</dt><dd>' + escapeHtml(reviewReasons || 'None') + '</dd>',
            '<dt>Sentiment</dt><dd>' + escapeHtml(sentimentText) + '</dd>',
            '<dt>Score</dt><dd>' + escapeHtml(sentimentScoreText) + '</dd>',
            '<dt>Assignment</dt><dd>' + escapeHtml(assignmentText) + '</dd>',
            '<dt>Review SLA</dt><dd>' + escapeHtml(reviewAgeText) + (reviewTiming.overdue ? ' | overdue' : ' | on track') + '</dd>',
            '<dt>Resolution</dt><dd>' + escapeHtml(resolutionText) + '</dd>',
            '<dt>Summary</dt><dd>' + escapeHtml(summary || 'n/a') + '</dd>',
            '</dl>',
            reviewActions,
            commentsMarkup,
            historyMarkup,
          ].join('');

          const actionButtons = dom.runDetail.querySelectorAll('[data-review-action]');
          actionButtons.forEach((button) => {
            button.addEventListener('click', async () => {
              const action = button.getAttribute('data-review-action');
              if (!action || !state.selectedRunId) {
                return;
              }

              const noteField = dom.runDetail.querySelector('#review-note');
              const note = noteField && 'value' in noteField ? String(noteField.value).trim() : '';
              if (action === 'ASSIGN_TO_ME') {
                await submitReviewAssignment(note || undefined);
                return;
              }

              if (action === 'ADD_COMMENT') {
                await submitReviewComment(note || undefined);
                return;
              }

              await submitReviewDecision(action, note || undefined);
            });
          });
        }

        function renderEvents() {
          dom.eventCount.textContent = state.events.length + ' events';
          dom.events.innerHTML = '';

          if (!state.events.length) {
            dom.events.innerHTML = '<li class="empty">No events recorded yet.</li>';
            return;
          }

          state.events.forEach((event) => {
            const item = document.createElement('li');
            item.className = 'card';
            item.innerHTML = [
              '<div class="panel-header">',
              '<strong>' + escapeHtml(event.type) + '</strong>',
              '<span class="muted">' + escapeHtml(event.createdAt) + '</span>',
              '</div>',
              '<div>' + escapeHtml(event.summary) + '</div>',
              '<div class="muted mono">' + escapeHtml(JSON.stringify(event.metadata || {})) + '</div>',
            ].join('');
            dom.events.appendChild(item);
          });
        }

        function renderAuditEvents() {
          dom.auditCount.textContent = state.auditEvents.length + ' events';
          dom.auditEvents.innerHTML = '';

          if (!state.auditEvents.length) {
            dom.auditEvents.innerHTML = '<li class="empty">No audit events recorded yet.</li>';
            return;
          }

          state.auditEvents.forEach((event) => {
            const item = document.createElement('li');
            item.className = 'card';
            const actor = event.actor ? event.actor.principalId + ' / ' + event.actor.principalType : 'system';
            item.innerHTML = [
              '<div class="panel-header">',
              '<strong>' + escapeHtml(event.action) + '</strong>',
              '<span class="muted">' + escapeHtml(event.occurredAt) + '</span>',
              '</div>',
              '<div class="muted">Actor: ' + escapeHtml(actor) + '</div>',
              '<div class="muted mono">' + escapeHtml(JSON.stringify(event.metadata || {})) + '</div>',
            ].join('');
            dom.auditEvents.appendChild(item);
          });
        }

        function renderReviewQueue() {
          const search = dom.reviewSearch.value.trim().toLowerCase();
          const assignmentFilter = dom.reviewAssignmentFilter.value;
          const items = state.reviewItems.filter((item) => {
            const assigned = Boolean(item.review.assignment);
            const assignmentMatch = assignmentFilter === 'all'
              || (assignmentFilter === 'assigned' && assigned)
              || (assignmentFilter === 'unassigned' && !assigned);
            const haystack = [item.jobId, ...(item.review.reasons || [])].join(' ').toLowerCase();
            const searchMatch = !search || haystack.includes(search);
            return assignmentMatch && searchMatch;
          });

          dom.reviewCount.textContent = items.length + ' visible / ' + state.reviewItems.length + ' queued';
          dom.reviewQueue.innerHTML = '';

          if (!items.length) {
            dom.reviewQueue.innerHTML = '<li class="empty">No review items in the current auth scope.</li>';
            return;
          }

          items.forEach((item) => {
            const node = document.createElement('li');
            const isSelected = state.selectedReviewIds.has(item.jobId);
            const timing = reviewSlaSummary(item);
            node.className = 'card ' + (isSelected ? 'active' : '');
            node.innerHTML = [
              '<div class="controls">',
              '<input type="checkbox" data-select-run-id="' + escapeHtml(item.jobId) + '"' + (isSelected ? ' checked' : '') + ' />',
              '<button type="button" data-run-id="' + escapeHtml(item.jobId) + '">',
              '<div class="panel-header">',
              '<strong class="mono">' + escapeHtml(item.jobId) + '</strong>',
              '<span class="badge review">' + escapeHtml(item.review.state) + '</span>',
              '</div>',
              '<div class="muted">Severity: ' + escapeHtml(item.severity) + '</div>',
              '<div class="muted">Assigned: ' + escapeHtml(item.review.assignment ? item.review.assignment.assigneeId : 'Unassigned') + '</div>',
              '<div class="muted">SLA: ' + escapeHtml(formatAge(timing.ageMinutes) + ' / ' + formatAge(timing.targetMinutes) + (timing.overdue ? ' overdue' : ' on track')) + '</div>',
              '<div class="muted">Reasons: ' + escapeHtml(item.review.reasons.join(', ')) + '</div>',
              '</button>',
              '</div>',
            ].join('');
            node.querySelector('button').addEventListener('click', () => selectRun(item.jobId));
            node.querySelector('[data-select-run-id]').addEventListener('change', (event) => {
              const checked = event.target && 'checked' in event.target ? Boolean(event.target.checked) : false;
              if (checked) {
                state.selectedReviewIds.add(item.jobId);
              } else {
                state.selectedReviewIds.delete(item.jobId);
              }
              renderReviewQueue();
            });
            dom.reviewQueue.appendChild(node);
          });
        }

        function syncTenantPackScopeFromRun(run) {
          if (!run) {
            return;
          }

          if (!dom.tenantPackTenantId.value && run.tenantId) {
            dom.tenantPackTenantId.value = run.tenantId;
          }

          if ((!dom.tenantPackUseCase.value || dom.tenantPackUseCase.value === 'support') && run.useCase) {
            dom.tenantPackUseCase.value = run.useCase;
          }
        }

        function tenantPackQueryPath() {
          const params = new URLSearchParams();
          const tenantId = dom.tenantPackTenantId.value.trim();
          const useCase = dom.tenantPackUseCase.value.trim() || 'support';
          if (tenantId) {
            params.set('tenantId', tenantId);
          }
          params.set('useCase', useCase);
          return '/v1/tenant-packs/active?' + params.toString();
        }

        function packScopePayload() {
          return {
            tenantId: dom.tenantPackTenantId.value.trim(),
            useCase: dom.tenantPackUseCase.value.trim() || 'support',
          };
        }

        function parseTenantPackEditor() {
          const raw = dom.tenantPackEditor.value.trim();
          if (!raw) {
            throw new Error('Tenant pack editor is empty.');
          }
          return JSON.parse(raw);
        }

        function releaseControls() {
          const approvalsRequired = Number(dom.tenantPackApprovalsRequired.value || 1);
          const canaryPercentage = Number(dom.tenantPackCanaryPercentage.value || 10);
          return {
            approvalsRequired: Number.isFinite(approvalsRequired) && approvalsRequired > 0 ? approvalsRequired : 1,
            canaryPercentage: Number.isFinite(canaryPercentage) && canaryPercentage > 0 ? canaryPercentage : 10,
          };
        }

        function releaseNote() {
          return dom.tenantPackNote.value.trim() || undefined;
        }

        function canaryMetrics() {
          const averageScoreText = dom.tenantPackCanaryAverageScore.value.trim();
          return {
            sampleSize: Math.max(0, Number(dom.tenantPackCanarySampleSize.value || 0)),
            failureRate: Math.min(1, Math.max(0, Number(dom.tenantPackCanaryFailureRate.value || 0) / 100)),
            reviewRate: Math.min(1, Math.max(0, Number(dom.tenantPackCanaryReviewRate.value || 0) / 100)),
            uncertainRate: Math.min(1, Math.max(0, Number(dom.tenantPackCanaryUncertainRate.value || 0) / 100)),
            averageScore100: averageScoreText ? Number(averageScoreText) : undefined,
          };
        }

        function validationQueryParams() {
          const params = new URLSearchParams();
          const tenantId = dom.tenantPackTenantId.value.trim();
          const useCase = dom.tenantPackUseCase.value.trim() || 'support';
          const packVersion = dom.tenantPackTargetVersion.value.trim() || state.selectedPackVersion || '';
          if (tenantId) {
            params.set('tenantId', tenantId);
          }
          params.set('useCase', useCase);
          if (packVersion) {
            params.set('packVersion', packVersion);
          }
          return params;
        }

        function renderValidationPanel() {
          const datasets = Array.isArray(state.validationDatasets) ? state.validationDatasets : [];
          const reports = Array.isArray(state.validationReports) ? state.validationReports : [];
          const alerts = Array.isArray(state.validationAlerts) ? state.validationAlerts : [];
          const latestReport = reports[0] || null;

          if (state.validationOutput) {
            dom.validationSummary.textContent = prettyJson(state.validationOutput);
            dom.validationSummary.className = 'card mono';
          } else if (latestReport) {
            const metrics = latestReport.liveMetrics || {};
            const reviewed = latestReport.reviewedMetrics || {};
            const regression = latestReport.regression || {};
            dom.validationSummary.textContent = prettyJson({
              generatedAt: latestReport.generatedAt,
              packVersion: latestReport.packVersion || '_all',
              runCount: metrics.runCount,
              failureRate: metrics.failureRate,
              reviewRate: metrics.reviewRate,
              uncertainRate: metrics.uncertainRate,
              schemaValidRate: metrics.schemaValidRate,
              averageProcessingDurationMs: metrics.averageProcessingDurationMs,
              p95ProcessingDurationMs: metrics.p95ProcessingDurationMs,
              reviewedSamples: reviewed.total,
              averageDeltaScore100: reviewed.averageDeltaScore100,
              averageDeltaScore5: reviewed.averageDeltaScore5,
              alertCount: Array.isArray(latestReport.alerts) ? latestReport.alerts.length : 0,
              regression,
            });
            dom.validationSummary.className = 'card mono';
          } else {
            dom.validationSummary.textContent = 'No validation report loaded.';
            dom.validationSummary.className = 'card muted';
          }

          dom.validationDatasets.innerHTML = '';
          if (!datasets.length) {
            dom.validationDatasets.innerHTML = '<li class=\"empty\">No reviewed dataset inventory for the current scope.</li>';
          } else {
            datasets.forEach((dataset) => {
              const item = document.createElement('li');
              item.className = 'card';
              item.innerHTML = [
                '<div class=\"panel-header\">',
                '<strong>' + escapeHtml(dataset.tenantId + '/' + dataset.useCase) + '</strong>',
                '<span class=\"muted\">files ' + escapeHtml(String(dataset.fileCount)) + '</span>',
                '</div>',
                '<div class=\"muted\">Records: ' + escapeHtml(String(dataset.recordCount)) + ' | Analyst sentiment: ' + escapeHtml(String(dataset.analystSentimentCount)) + '</div>',
                '<div class=\"muted\">Queues: ' + escapeHtml(Object.keys(dataset.byQueue || {}).join(', ') || 'n/a') + '</div>',
                '<div class=\"muted\">Lengths: ' + escapeHtml(Object.keys(dataset.byTranscriptLengthBucket || {}).join(', ') || 'n/a') + '</div>',
              ].join('');
              dom.validationDatasets.appendChild(item);
            });
          }

          dom.validationBreakdowns.innerHTML = '';
          if (!latestReport) {
            dom.validationBreakdowns.innerHTML = '<li class=\"empty\">No queue or transcript-length breakdowns available yet.</li>';
          } else {
            const queueEntries = Object.entries((latestReport.liveMetrics && latestReport.liveMetrics.byQueue) || {});
            const lengthEntries = Object.entries((latestReport.liveMetrics && latestReport.liveMetrics.byTranscriptLengthBucket) || {});
            const sections = [
              ['Queues', queueEntries, latestReport.reviewedMetrics && latestReport.reviewedMetrics.byQueue ? latestReport.reviewedMetrics.byQueue : {}],
              ['Transcript Length', lengthEntries, latestReport.reviewedMetrics && latestReport.reviewedMetrics.byTranscriptLengthBucket ? latestReport.reviewedMetrics.byTranscriptLengthBucket : {}],
            ];
            sections.forEach(([label, entries, reviewed]) => {
              const scopedEntries = Array.isArray(entries) ? entries : [];
              if (!scopedEntries.length) {
                return;
              }
              scopedEntries.forEach(([name, bucket]) => {
                const reviewedBucket = reviewed && reviewed[name] ? reviewed[name] : null;
                const item = document.createElement('li');
                item.className = 'card';
                item.innerHTML = [
                  '<div class=\"panel-header\">',
                  '<strong>' + escapeHtml(String(label) + ': ' + name) + '</strong>',
                  '<span class=\"muted\">runs ' + escapeHtml(String(bucket.runCount)) + '</span>',
                  '</div>',
                  '<div class=\"muted\">Failure: ' + escapeHtml(String(bucket.failureRate)) + ' | Review: ' + escapeHtml(String(bucket.reviewRate)) + ' | Uncertain: ' + escapeHtml(String(bucket.uncertainRate)) + '</div>',
                  '<div class=\"muted\">Schema-valid: ' + escapeHtml(typeof bucket.schemaValidRate === 'number' ? String(bucket.schemaValidRate) : 'n/a') + ' | P95: ' + escapeHtml(typeof bucket.p95ProcessingDurationMs === 'number' ? String(bucket.p95ProcessingDurationMs) + 'ms' : 'n/a') + '</div>',
                  '<div class=\"muted\">Reviewed: ' + escapeHtml(reviewedBucket ? String(reviewedBucket.total) : '0') + ' | Drift100: ' + escapeHtml(reviewedBucket ? String(reviewedBucket.averageDeltaScore100) : 'n/a') + '</div>',
                ].join('');
                dom.validationBreakdowns.appendChild(item);
              });
            });
            if (!dom.validationBreakdowns.children.length) {
              dom.validationBreakdowns.innerHTML = '<li class=\"empty\">No queue or transcript-length breakdowns available yet.</li>';
            }
          }

          dom.validationReports.innerHTML = '';
          if (!reports.length) {
            dom.validationReports.innerHTML = '<li class=\"empty\">No validation reports for the current scope.</li>';
          } else {
            reports.forEach((report) => {
              const item = document.createElement('li');
              item.className = 'card';
              item.innerHTML = [
                '<div class=\"panel-header\">',
                '<strong>' + escapeHtml(report.packVersion || '_all') + '</strong>',
                '<span class=\"muted\">' + escapeHtml(report.generatedAt) + '</span>',
                '</div>',
                '<div class=\"muted\">Runs: ' + escapeHtml(String(report.liveMetrics.runCount)) + ' | Failure: ' + escapeHtml(String(report.liveMetrics.failureRate)) + '</div>',
                '<div class=\"muted\">Schema-valid: ' + escapeHtml(typeof report.liveMetrics.schemaValidRate === 'number' ? String(report.liveMetrics.schemaValidRate) : 'n/a') + ' | P95: ' + escapeHtml(typeof report.liveMetrics.p95ProcessingDurationMs === 'number' ? String(report.liveMetrics.p95ProcessingDurationMs) + 'ms' : 'n/a') + '</div>',
                '<div class=\"muted\">Reviewed: ' + escapeHtml(report.reviewedMetrics ? String(report.reviewedMetrics.total) : '0') + ' | Alerts: ' + escapeHtml(String((report.alerts || []).length)) + '</div>',
              ].join('');
              dom.validationReports.appendChild(item);
            });
          }

          dom.validationAlerts.innerHTML = '';
          if (!alerts.length) {
            dom.validationAlerts.innerHTML = '<li class=\"empty\">No validation alerts for the current scope.</li>';
            dom.validationStatus.textContent = latestReport ? 'Reports loaded' : 'Idle';
            return;
          }

          alerts.forEach((alert) => {
            const item = document.createElement('li');
            item.className = 'card';
            const scopeBits = [];
            if (alert.metadata && alert.metadata.scopeType && alert.metadata.scopeValue) {
              scopeBits.push(String(alert.metadata.scopeType) + '=' + String(alert.metadata.scopeValue));
            }
            if (alert.metadata && alert.metadata.engagementType) {
              scopeBits.push('engagement=' + String(alert.metadata.engagementType));
            }
            item.innerHTML = [
              '<div class=\"panel-header\">',
              '<strong>' + escapeHtml(alert.kind) + '</strong>',
              '<span class=\"badge ' + badgeClass(alert.severity) + '\">' + escapeHtml(alert.severity) + '</span>',
              '</div>',
              '<div class=\"muted\">' + escapeHtml(alert.createdAt) + '</div>',
              scopeBits.length ? '<div class=\"muted\">' + escapeHtml(scopeBits.join(' | ')) + '</div>' : '',
              '<div>' + escapeHtml(alert.message) + '</div>',
            ].join('');
            dom.validationAlerts.appendChild(item);
          });

          dom.validationStatus.textContent = alerts.length + ' alerts';
        }

        function renderTenantPackPanel() {
          const stateSnapshot = state.tenantPackState;
          if (stateSnapshot) {
            dom.tenantPackStatus.textContent = stateSnapshot.activeVersion
              ? 'Active ' + stateSnapshot.activeVersion
              : 'No active pack';
          } else {
            dom.tenantPackStatus.textContent = 'Idle';
          }

          if (state.tenantPackOutput) {
            dom.tenantPackOutput.textContent = prettyJson(state.tenantPackOutput);
            dom.tenantPackOutput.className = 'card mono';
          } else if (stateSnapshot) {
            dom.tenantPackOutput.textContent = prettyJson(stateSnapshot);
            dom.tenantPackOutput.className = 'card mono';
          } else {
            dom.tenantPackOutput.textContent = 'No tenant pack loaded.';
            dom.tenantPackOutput.className = 'card muted';
          }

          dom.tenantPackReleases.innerHTML = '';
          dom.tenantPackHistory.innerHTML = '';
          const releases = stateSnapshot && Array.isArray(stateSnapshot.releases) ? stateSnapshot.releases : [];
          if (!releases.length) {
            dom.tenantPackReleases.innerHTML = '<li class="empty">No release records yet.</li>';
            dom.tenantPackHistory.innerHTML = '<li class="empty">No release history recorded yet.</li>';
            return;
          }

          const selectedVersion = state.selectedPackVersion || dom.tenantPackTargetVersion.value.trim() || releases[0].packVersion;
          state.selectedPackVersion = selectedVersion;

          releases.forEach((release) => {
            const item = document.createElement('li');
            item.className = 'card ' + (release.packVersion === selectedVersion ? 'active' : '');
            item.innerHTML = [
              '<button type="button" data-pack-version="' + escapeHtml(release.packVersion) + '">',
              '<div class="panel-header">',
              '<strong class="mono">' + escapeHtml(release.packVersion) + '</strong>',
              '<span class="badge ' + badgeClass(release.status) + '">' + escapeHtml(release.status) + '</span>',
              '</div>',
              '<div class="muted">Mode: ' + escapeHtml(release.mode) + '</div>',
              '<div class="muted">Approvals: ' + escapeHtml(String((release.approvals || []).length)) + '/' + escapeHtml(String(release.approvalsRequired || 0)) + '</div>',
              '<div class="muted">Canary: ' + escapeHtml(release.canary ? String(release.canary.percentage) + '%' : 'n/a') + '</div>',
              '</button>',
            ].join('');
            item.querySelector('button').addEventListener('click', () => {
              state.selectedPackVersion = release.packVersion;
              dom.tenantPackTargetVersion.value = release.packVersion;
              dom.tenantPackNote.value = release.note || '';
              renderTenantPackPanel();
            });
            dom.tenantPackReleases.appendChild(item);
          });

          const selectedRelease = releases.find((release) => release.packVersion === selectedVersion) || releases[0];
          if (!selectedRelease) {
            dom.tenantPackHistory.innerHTML = '<li class="empty">No release history recorded yet.</li>';
            return;
          }

          const historyEntries = Array.isArray(selectedRelease.history) ? selectedRelease.history.slice().reverse() : [];
          if (!historyEntries.length) {
            dom.tenantPackHistory.innerHTML = '<li class="empty">No release history recorded yet.</li>';
            return;
          }

          historyEntries.forEach((entry) => {
            const item = document.createElement('li');
            item.className = 'card';
            item.innerHTML = [
              '<div class="panel-header">',
              '<strong>' + escapeHtml(entry.kind) + '</strong>',
              '<span class="muted">' + escapeHtml(entry.createdAt) + '</span>',
              '</div>',
              '<div class="muted">Actor: ' + escapeHtml(entry.actorId || 'system') + '</div>',
              '<div class="muted">Status: ' + escapeHtml(entry.status || selectedRelease.status) + '</div>',
              '<div>' + escapeHtml(entry.note || JSON.stringify(entry.metadata || {})) + '</div>',
            ].join('');
            dom.tenantPackHistory.appendChild(item);
          });
        }

        async function refreshTenantPackState() {
          try {
            state.tenantPackState = await api(tenantPackQueryPath());
            state.tenantPackOutput = state.tenantPackState;
            if (state.tenantPackState.activePack) {
              dom.tenantPackEditor.value = prettyJson(state.tenantPackState.activePack.runtimePack);
            }
            renderTenantPackPanel();
          } catch (error) {
            state.tenantPackState = null;
            state.tenantPackOutput = {
              error: error instanceof Error ? error.message : String(error),
            };
            renderTenantPackPanel();
          }
        }

        async function performTenantPackAction(path, body, options = {}) {
          const payload = await api(path, {
            method: options.method || 'POST',
            headers: {
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          });

          state.tenantPackOutput = payload;
          if (payload.compiledPack && payload.compiledPack.runtimePack) {
            dom.tenantPackEditor.value = prettyJson(payload.compiledPack.runtimePack);
          }
          if (payload.release && payload.release.packVersion) {
            state.selectedPackVersion = payload.release.packVersion;
            dom.tenantPackTargetVersion.value = payload.release.packVersion;
          } else if (payload.activeVersion) {
            state.selectedPackVersion = payload.activeVersion;
            dom.tenantPackTargetVersion.value = payload.activeVersion;
          }
          await refreshTenantPackState();
          state.tenantPackOutput = payload;
          renderTenantPackPanel();
        }

        async function refreshValidationDashboard() {
          dom.validationStatus.textContent = 'Loading validation...';
          const params = validationQueryParams();
          const query = params.toString();
          const datasetsResponse = await api('/v1/model-validation/reviewed-datasets?' + query);
          const reportsResponse = await api('/v1/model-validation/reports?' + query);
          const alertsResponse = await api('/v1/model-validation/alerts?' + query);
          state.validationDatasets = datasetsResponse.scopes || [];
          state.validationReports = reportsResponse.reports || [];
          state.validationAlerts = alertsResponse.alerts || [];
          state.validationOutput = null;
          renderValidationPanel();
        }

        async function refreshReviewedExports() {
          dom.validationStatus.textContent = 'Refreshing reviewed exports...';
          const params = validationQueryParams();
          state.validationOutput = await api('/v1/model-validation/refresh-reviewed-exports', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              tenantId: params.get('tenantId') || undefined,
              useCase: params.get('useCase') || undefined,
              force: true,
            }),
          });
          await refreshValidationDashboard();
        }

        async function runValidationNow() {
          dom.validationStatus.textContent = 'Running validation...';
          const params = validationQueryParams();
          state.validationOutput = await api('/v1/model-validation/run', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              tenantId: params.get('tenantId') || undefined,
              useCase: params.get('useCase') || undefined,
              force: true,
            }),
          });
          await refreshValidationDashboard();
        }

        async function recommendValidationThresholds() {
          dom.validationStatus.textContent = 'Computing recommendations...';
          const params = validationQueryParams();
          state.validationOutput = await api('/v1/model-validation/recommend-thresholds?' + params.toString());
          renderValidationPanel();
        }

        async function publishTenantPack(mode) {
          const release = mode === 'DIRECT'
            ? { note: releaseNote() }
            : {
              mode,
              approvalsRequired: mode === 'APPROVAL_REQUIRED' ? releaseControls().approvalsRequired : undefined,
              canaryPercentage: releaseControls().canaryPercentage,
              note: releaseNote(),
            };

          await performTenantPackAction('/v1/tenant-packs/publish', {
            tenantPack: parseTenantPackEditor(),
            release,
          });
        }

        function stopLiveUpdates() {
          if (state.eventSource) {
            state.eventSource.close();
            state.eventSource = null;
          }
          if (state.pollTimer) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
          }
        }

        async function refreshSelectedRun() {
          if (!state.selectedRunId) {
            return;
          }

          state.selectedRun = await api('/v1/runs/' + encodeURIComponent(state.selectedRunId));
          renderSelectedRun();
        }

        async function refreshSelectedEvents() {
          if (!state.selectedRunId) {
            return;
          }

          const snapshot = await api('/v1/runs/' + encodeURIComponent(state.selectedRunId) + '/events');
          state.events = snapshot.events || [];
          renderEvents();
        }

        async function refreshSelectedAudit() {
          if (!state.selectedRunId) {
            return;
          }

          const snapshot = await api('/v1/runs/' + encodeURIComponent(state.selectedRunId) + '/audit');
          state.auditEvents = snapshot.items || [];
          renderAuditEvents();
        }

        function startLiveUpdates(runId) {
          stopLiveUpdates();

          if (state.apiKey || !window.EventSource) {
            dom.runLiveState.textContent = 'Polling';
            state.pollTimer = window.setInterval(() => {
              void refreshSelectedRun().catch(reportError);
              void refreshSelectedEvents().catch(reportError);
              void refreshSelectedAudit().catch(reportError);
              void refreshRuns().catch(reportError);
              void refreshReviewQueue().catch(reportError);
              void refreshReviewAnalyticsSnapshot().catch(reportError);
            }, 2000);
            return;
          }

          dom.runLiveState.textContent = 'SSE';
          state.eventSource = new EventSource('/v1/runs/' + encodeURIComponent(runId) + '/stream');
          eventTypes.forEach((eventType) => {
            state.eventSource.addEventListener(eventType, () => {
              void refreshSelectedRun().catch(reportError);
              void refreshSelectedEvents().catch(reportError);
              void refreshSelectedAudit().catch(reportError);
              void refreshRuns().catch(reportError);
              void refreshReviewQueue().catch(reportError);
              void refreshReviewAnalyticsSnapshot().catch(reportError);
            });
          });
          state.eventSource.addEventListener('error', () => {
            dom.runLiveState.textContent = 'Reconnecting';
          });
        }

        async function selectRun(runId) {
          state.selectedRunId = runId;
          dom.runLiveState.textContent = 'Loading';
          renderRuns();
          await refreshSelectedRun();
          await refreshSelectedEvents();
          await refreshSelectedAudit();
          startLiveUpdates(runId);
        }

        async function refreshRuns() {
          dom.runStatus.textContent = 'Refreshing runs...';
          const snapshot = await api('/v1/runs');
          state.runs = snapshot.runs || [];
          renderRuns();
          dom.runStatus.textContent = 'Runs refreshed.';

          if (!state.selectedRunId && state.runs[0]) {
            await selectRun(state.runs[0].jobId);
            return;
          }

          if (state.selectedRunId && !state.runs.some((run) => run.jobId === state.selectedRunId)) {
            stopLiveUpdates();
            state.selectedRunId = null;
            state.selectedRun = null;
            state.events = [];
            state.auditEvents = [];
            renderSelectedRun();
            renderEvents();
            renderAuditEvents();
          }
        }

        async function refreshReviewQueue() {
          const snapshot = await api('/v1/review-queue');
          state.reviewItems = snapshot.items || [];
          state.selectedReviewIds = new Set(Array.from(state.selectedReviewIds).filter((jobId) => state.reviewItems.some((item) => item.jobId === jobId)));
          renderReviewQueue();
        }

        async function refreshReviewAnalyticsSnapshot() {
          state.reviewAnalytics = await api('/v1/review-analytics');
          renderReviewAnalytics();
        }

        function renderReviewAnalytics() {
          const analytics = state.reviewAnalytics;
          if (!analytics) {
            dom.reviewAnalytics.innerHTML = '<div class="muted">No review analytics yet.</div>';
            return;
          }

          const topActors = (analytics.byActor || []).slice(0, 3)
            .map((item) => item.actorId + ' (' + item.decisionCount + ')')
            .join(', ');
          const configuredPolicies = Array.isArray(analytics.sla.configuredPolicies)
            ? analytics.sla.configuredPolicies
            : [];

          dom.reviewAnalytics.innerHTML = [
            '<div class="panel-header"><h2>Analytics</h2><span class="muted">' + escapeHtml(analytics.generatedAt) + '</span></div>',
            '<div class="muted">Pending: ' + escapeHtml(String(analytics.pendingCount)) + '</div>',
            '<div class="muted">Assigned: ' + escapeHtml(String(analytics.assignedCount)) + '</div>',
            '<div class="muted">SLA Overdue: ' + escapeHtml(String(analytics.sla.overdueCount)) + ' (' + escapeHtml(String(analytics.sla.unassignedOverdueCount)) + ' unassigned / ' + escapeHtml(String(analytics.sla.assignedOverdueCount)) + ' assigned)</div>',
            '<div class="muted">Oldest Pending: ' + escapeHtml(formatAge(analytics.sla.oldestPendingAgeMinutes)) + ' / ' + escapeHtml(formatAge(analytics.sla.pendingTargetMinutes)) + '</div>',
            '<div class="muted">Oldest Assigned: ' + escapeHtml(formatAge(analytics.sla.oldestAssignedAgeMinutes)) + ' / ' + escapeHtml(formatAge(analytics.sla.assignedTargetMinutes)) + '</div>',
            '<div class="muted">Verified: ' + escapeHtml(String(analytics.resultingStateCounts.VERIFIED)) + '</div>',
            '<div class="muted">Uncertain: ' + escapeHtml(String(analytics.resultingStateCounts.UNCERTAIN)) + '</div>',
            '<div class="muted">Kept In Review: ' + escapeHtml(String(analytics.decisionCounts.KEEP_NEEDS_REVIEW)) + '</div>',
            '<div class="muted">Top Reviewers: ' + escapeHtml(topActors || 'None') + '</div>',
            '<div class="muted">Policies: ' + escapeHtml(configuredPolicies.length ? configuredPolicies.map((policy) => policy.useCase + ' [' + policy.assignmentMode + ']').join(', ') : 'Default') + '</div>',
          ].join('');
        }

        async function submitReviewDecision(decision, note) {
          if (!state.selectedRunId) {
            return;
          }

          state.reviewActionPending = true;
          dom.runLiveState.textContent = 'Submitting review';

          try {
            await api('/v1/runs/' + encodeURIComponent(state.selectedRunId) + '/review', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                decision,
                note,
              }),
            });
            await refreshAll();
          } finally {
            state.reviewActionPending = false;
          }
        }

        async function submitReviewComment(comment) {
          if (!state.selectedRunId) {
            return;
          }
          if (!comment) {
            throw new Error('Enter a comment before submitting.');
          }

          state.reviewActionPending = true;
          dom.runLiveState.textContent = 'Adding comment';

          try {
            await api('/v1/runs/' + encodeURIComponent(state.selectedRunId) + '/comments', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                comment,
              }),
            });
            await refreshAll();
          } finally {
            state.reviewActionPending = false;
          }
        }

        async function submitReviewAssignment(note) {
          if (!state.selectedRunId) {
            return;
          }

          state.reviewActionPending = true;
          dom.runLiveState.textContent = 'Assigning review';

          try {
            await api('/v1/runs/' + encodeURIComponent(state.selectedRunId) + '/assignment', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                note,
              }),
            });
            await refreshAll();
          } finally {
            state.reviewActionPending = false;
          }
        }

        async function submitBulkReviewAction(kind) {
          const runIds = Array.from(state.selectedReviewIds);
          if (!runIds.length) {
            throw new Error('Select at least one review item first.');
          }

          const note = dom.bulkReviewNote.value.trim() || undefined;
          state.reviewActionPending = true;
          dom.runLiveState.textContent = 'Bulk review';

          try {
            for (const runId of runIds) {
              if (kind === 'ASSIGN') {
                await api('/v1/runs/' + encodeURIComponent(runId) + '/assignment', {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify({ note }),
                });
                continue;
              }

              await api('/v1/runs/' + encodeURIComponent(runId) + '/review', {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                },
                body: JSON.stringify({
                  decision: kind,
                  note,
                }),
              });
            }

            state.selectedReviewIds.clear();
            await refreshAll();
          } finally {
            state.reviewActionPending = false;
          }
        }

        function reportError(error) {
          const message = error instanceof Error ? error.message : String(error);
          dom.runStatus.textContent = message;
          dom.runLiveState.textContent = 'Error';
        }

        async function refreshAll() {
          try {
            await refreshRuns();
            await refreshReviewQueue();
            await refreshReviewAnalyticsSnapshot();
            await refreshTenantPackState();
            await refreshValidationDashboard();
            if (state.selectedRunId) {
              await refreshSelectedRun();
              await refreshSelectedEvents();
              await refreshSelectedAudit();
            }
          } catch (error) {
            reportError(error);
          }
        }

        dom.applyApiKey.addEventListener('click', async () => {
          state.apiKey = dom.apiKey.value.trim();
          localStorage.setItem('ci-console-api-key', state.apiKey);
          if (state.selectedRunId) {
            startLiveUpdates(state.selectedRunId);
          }
          await refreshAll();
        });

        dom.refresh.addEventListener('click', () => {
          void refreshAll();
        });

        dom.runSearch.addEventListener('input', renderRuns);
        dom.runStatusFilter.addEventListener('change', renderRuns);
        dom.reviewSearch.addEventListener('input', renderReviewQueue);
        dom.reviewAssignmentFilter.addEventListener('change', renderReviewQueue);
        dom.bulkSelectVisible.addEventListener('click', () => {
          state.reviewItems.forEach((item) => {
            const search = dom.reviewSearch.value.trim().toLowerCase();
            const assignmentFilter = dom.reviewAssignmentFilter.value;
            const assigned = Boolean(item.review.assignment);
            const assignmentMatch = assignmentFilter === 'all'
              || (assignmentFilter === 'assigned' && assigned)
              || (assignmentFilter === 'unassigned' && !assigned);
            const haystack = [item.jobId, ...(item.review.reasons || [])].join(' ').toLowerCase();
            const searchMatch = !search || haystack.includes(search);
            if (assignmentMatch && searchMatch) {
              state.selectedReviewIds.add(item.jobId);
            }
          });
          renderReviewQueue();
        });
        dom.bulkClearSelection.addEventListener('click', () => {
          state.selectedReviewIds.clear();
          renderReviewQueue();
        });
        dom.bulkAssign.addEventListener('click', () => {
          void submitBulkReviewAction('ASSIGN').catch(reportError);
        });
        dom.bulkVerify.addEventListener('click', () => {
          void submitBulkReviewAction('VERIFY').catch(reportError);
        });
        dom.bulkMarkUncertain.addEventListener('click', () => {
          void submitBulkReviewAction('MARK_UNCERTAIN').catch(reportError);
        });
        dom.bulkKeepReview.addEventListener('click', () => {
          void submitBulkReviewAction('KEEP_NEEDS_REVIEW').catch(reportError);
        });

        dom.tenantPackLoad.addEventListener('click', () => {
          void refreshTenantPackState();
        });

        dom.tenantPackValidate.addEventListener('click', () => {
          try {
            void performTenantPackAction('/v1/tenant-packs/validate', {
              tenantPack: parseTenantPackEditor(),
            });
          } catch (error) {
            reportError(error);
          }
        });

        dom.tenantPackPreview.addEventListener('click', () => {
          try {
            void performTenantPackAction('/v1/tenant-packs/preview', {
              tenantPack: parseTenantPackEditor(),
            });
          } catch (error) {
            reportError(error);
          }
        });

        dom.tenantPackPublish.addEventListener('click', () => {
          try {
            void publishTenantPack('DIRECT');
          } catch (error) {
            reportError(error);
          }
        });

        dom.tenantPackPublishApproval.addEventListener('click', () => {
          try {
            void publishTenantPack('APPROVAL_REQUIRED');
          } catch (error) {
            reportError(error);
          }
        });

        dom.tenantPackPublishCanary.addEventListener('click', () => {
          try {
            void publishTenantPack('CANARY');
          } catch (error) {
            reportError(error);
          }
        });

        dom.tenantPackApprove.addEventListener('click', () => {
          const scope = packScopePayload();
          const targetPackVersion = dom.tenantPackTargetVersion.value.trim();
          if (!scope.tenantId || !targetPackVersion) {
            reportError(new Error('Tenant ID and target version are required to approve a release.'));
            return;
          }

          void performTenantPackAction('/v1/tenant-packs/approve', {
            tenantId: scope.tenantId,
            useCase: scope.useCase,
            targetPackVersion,
            note: releaseNote(),
          });
        });

        dom.tenantPackComment.addEventListener('click', () => {
          const scope = packScopePayload();
          const targetPackVersion = dom.tenantPackTargetVersion.value.trim();
          const comment = releaseNote();
          if (!scope.tenantId || !targetPackVersion) {
            reportError(new Error('Tenant ID and target version are required to add a release comment.'));
            return;
          }
          if (!comment) {
            reportError(new Error('Enter a release note or comment first.'));
            return;
          }

          void performTenantPackAction('/v1/tenant-packs/comment', {
            tenantId: scope.tenantId,
            useCase: scope.useCase,
            targetPackVersion,
            comment,
          });
        });

        dom.tenantPackEvaluateCanary.addEventListener('click', () => {
          const scope = packScopePayload();
          const targetPackVersion = dom.tenantPackTargetVersion.value.trim();
          if (!scope.tenantId || !targetPackVersion) {
            reportError(new Error('Tenant ID and target version are required to evaluate a canary.'));
            return;
          }

          void performTenantPackAction('/v1/tenant-packs/evaluate-canary', {
            tenantId: scope.tenantId,
            useCase: scope.useCase,
            targetPackVersion,
            metrics: canaryMetrics(),
            applyResult: Boolean(dom.tenantPackCanaryApply.checked),
            note: releaseNote(),
          });
        });

        dom.tenantPackPromote.addEventListener('click', () => {
          const scope = packScopePayload();
          const targetPackVersion = dom.tenantPackTargetVersion.value.trim();
          if (!scope.tenantId || !targetPackVersion) {
            reportError(new Error('Tenant ID and target version are required to promote a canary.'));
            return;
          }

          void performTenantPackAction('/v1/tenant-packs/promote', {
            tenantId: scope.tenantId,
            useCase: scope.useCase,
            targetPackVersion,
            result: 'PASS',
            note: releaseNote(),
          });
        });

        dom.tenantPackFailCanary.addEventListener('click', () => {
          const scope = packScopePayload();
          const targetPackVersion = dom.tenantPackTargetVersion.value.trim();
          if (!scope.tenantId || !targetPackVersion) {
            reportError(new Error('Tenant ID and target version are required to fail a canary.'));
            return;
          }

          void performTenantPackAction('/v1/tenant-packs/promote', {
            tenantId: scope.tenantId,
            useCase: scope.useCase,
            targetPackVersion,
            result: 'FAIL',
            note: releaseNote(),
          });
        });

        dom.tenantPackRollback.addEventListener('click', () => {
          const scope = packScopePayload();
          const targetPackVersion = dom.tenantPackTargetVersion.value.trim();
          if (!scope.tenantId) {
            reportError(new Error('Tenant ID is required for rollback.'));
            return;
          }
          if (!targetPackVersion) {
            reportError(new Error('Rollback target version is required.'));
            return;
          }

          void performTenantPackAction('/v1/tenant-packs/rollback', {
            tenantId: scope.tenantId,
            useCase: scope.useCase,
            targetPackVersion,
            note: releaseNote(),
          });
        });

        dom.validationRefresh.addEventListener('click', () => {
          void refreshValidationDashboard().catch(reportError);
        });
        dom.validationRefreshExports.addEventListener('click', () => {
          void refreshReviewedExports().catch(reportError);
        });
        dom.validationRecommend.addEventListener('click', () => {
          void recommendValidationThresholds().catch(reportError);
        });
        dom.validationRun.addEventListener('click', () => {
          void runValidationNow().catch(reportError);
        });

        window.addEventListener('beforeunload', () => {
          stopLiveUpdates();
        });

        void refreshAll();
      })();
    </script>
  </body>
</html>`;
}
