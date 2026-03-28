import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { URL } from 'url';
import { ZodError } from 'zod';
import { AnalysisRequest, analysisRequestSchema } from '../contracts/jobs';
import { ConversationIntelligenceService } from '../service/conversation-intelligence-service';

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body, null, 2));
}

function notFound(response: ServerResponse): void {
  sendJson(response, 404, { error: 'Not found' });
}

function parseJobId(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/jobs\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function startConversationIntelligenceServer(
  service: ConversationIntelligenceService,
  port = 8787,
): Promise<Server> {
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    try {
      if (method === 'GET' && url.pathname === '/healthz') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/analyze') {
        const body = analysisRequestSchema.parse(await readJsonBody(request)) as AnalysisRequest;
        const result = await service.analyzeNow(body);
        sendJson(response, 200, result);
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/jobs') {
        const body = analysisRequestSchema.parse(await readJsonBody(request)) as AnalysisRequest;
        const job = await service.submitJob(body);
        sendJson(response, 202, job);
        return;
      }

      if (method === 'GET' && url.pathname === '/v1/jobs') {
        const jobs = await service.listJobs();
        sendJson(response, 200, { jobs });
        return;
      }

      if (method === 'GET' && url.pathname === '/v1/review-queue') {
        const snapshot = await service.listReviewQueue();
        sendJson(response, 200, snapshot);
        return;
      }

      if (method === 'GET') {
        const jobId = parseJobId(url.pathname);

        if (jobId) {
          const job = await service.getJob(jobId);
          if (!job) {
            notFound(response);
            return;
          }

          sendJson(response, 200, job);
          return;
        }
      }

      notFound(response);
    } catch (error) {
      if (error instanceof ZodError) {
        sendJson(response, 400, {
          error: 'Invalid request',
          issues: error.issues,
        });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}
