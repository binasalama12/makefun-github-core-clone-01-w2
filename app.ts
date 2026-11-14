// app.ts — the HTTP server: one dispatcher that authenticates, then hands
// each surface to its own module — REST to rest.ts's router table,
// GraphQL to graphql.ts, MCP to mcp.ts and git smart HTTP to githttp.ts,
// all over a single ForgeStore instance.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ForgeStore } from './store.ts';
import { dispatchRest } from './rest.ts';
import { executeGraphQL, type GraphQLRequest } from './graphql.ts';
import { handleRpc } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36).padStart(6, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = body === '' ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...(text ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...extra,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON body: `{value}` on success, `{malformed: true}` otherwise. */
function parseJsonBody(raw: Buffer): { value: unknown; malformed: boolean } {
  if (raw.length === 0) return { value: {}, malformed: false };
  try {
    return { value: JSON.parse(raw.toString('utf8')), malformed: false };
  } catch {
    return { value: null, malformed: true };
  }
}

export function createApp(): Server {
  const store = new ForgeStore();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Every other surface requires the trial's bearer token.
        const authorization = req.headers.authorization ?? '';
        if (token === '' || authorization !== `Bearer ${token}`) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }

        const raw = await readBody(req);

        // ---- REST v3
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          let body: Record<string, unknown> = {};
          if (raw.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
            const parsed = parseJsonBody(raw);
            if (parsed.malformed) {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
            body = (parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
              ? parsed.value
              : {}) as Record<string, unknown>;
          }
          const host = req.headers.host ?? 'localhost';
          const reply = dispatchRest(
            { store, params: [], query: url.searchParams, body, baseUrl: `http://${host}` },
            method,
            path,
          );
          if (!reply) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const headers: Record<string, string> = { ...(reply.headers ?? {}) };
          if (path === '/api/v3' || path === '/api/v3/') headers['x-oauth-scopes'] = 'repo, read:org';
          sendJson(res, reply.status, reply.body, headers);
          return;
        }

        // ---- GraphQL v4
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const parsed = parseJsonBody(raw);
          if (parsed.malformed) {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          if (Array.isArray(parsed.value)) {
            const results = parsed.value.map((item) => executeGraphQL(store, (item ?? {}) as GraphQLRequest));
            sendJson(res, 200, results);
            return;
          }
          const result = executeGraphQL(store, (parsed.value ?? {}) as GraphQLRequest);
          sendJson(res, 200, result);
          return;
        }

        // ---- MCP
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'method not allowed' } });
            return;
          }
          const text = raw.toString('utf8');
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            res.writeHead(400, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
            res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
            return;
          }
          if (Array.isArray(value)) {
            const replies = value
              .map((item) => handleRpc(store, (item ?? {}) as Record<string, unknown>))
              .filter((reply) => reply.payload !== null)
              .map((reply) => reply.payload);
            sendJson(res, 200, replies);
            return;
          }
          const reply = handleRpc(store, (value ?? {}) as Record<string, unknown>);
          if (reply.payload === null) {
            res.writeHead(202, { 'content-type': JSON_TYPE });
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.payload);
          return;
        }

        // ---- git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const endpoint = gitMatch[3];
          const repo = store.getRepo(owner, repoName);
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const gitProtocol = req.headers['git-protocol'] ?? '';
          if (method === 'GET' && endpoint === 'info/refs') {
            const service = url.searchParams.get('service') ?? 'git-upload-pack';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 403, { message: 'Unsupported service' });
              return;
            }
            const result = infoRefs(repo.git, service, typeof gitProtocol === 'string' ? gitProtocol : '');
            sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          if (method === 'POST' && endpoint === 'git-upload-pack') {
            try {
              const result = uploadPack(repo.git, raw, typeof gitProtocol === 'string' ? gitProtocol : '');
              sendRaw(res, result.status, result.contentType, result.body);
            } catch {
              sendRaw(res, 400, 'text/plain', Buffer.from('invalid upload-pack request\n'));
            }
            return;
          }
          if (method === 'POST' && endpoint === 'git-receive-pack') {
            try {
              const result = receivePack(repo, raw);
              sendRaw(res, result.status, result.contentType, result.body);
            } catch {
              sendRaw(res, 400, 'text/plain', Buffer.from('invalid receive-pack request\n'));
            }
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}
