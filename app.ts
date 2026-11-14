// app.ts — HTTP server: routing, auth, request ids, body reading.
// Surfaces: /healthz, /api/v3/*, /api/graphql, /mcp, /{owner}/{repo}.git/*.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { GraphQLExecutor, parseGraphQLDocument } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './githttp.ts';

let requestCounter = 0;

function jsonBody(status: number, obj: unknown): { status: number; contentType: string; body: Buffer } {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify(obj), 'utf8') };
}

export function createApp(): Server {
  const forge = new Forge();
  const executor = new GraphQLExecutor(forge);
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = `req-${++requestCounter}`;
    const send = (status: number, contentType: string, body: Buffer, extraHeaders?: Record<string, string>): void => {
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'X-GitHub-Request-Id': requestId,
        ...(extraHeaders ?? {}),
      };
      if (status === 204 || body.length === 0) {
        res.writeHead(status, headers);
        res.end();
        return;
      }
      res.writeHead(status, headers);
      res.end(body);
    };
    const sendJson = (status: number, obj: unknown, extraHeaders?: Record<string, string>): void => {
      const r = jsonBody(status, obj);
      send(r.status, r.contentType, r.body, extraHeaders);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      // Health probe: no auth.
      if (pathname === '/healthz') {
        if (method !== 'GET') return sendJson(405, { message: 'Method Not Allowed' });
        return sendJson(200, { ok: true });
      }

      // Read body for methods that may carry one.
      let rawBody = Buffer.alloc(0);
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
          const buf = chunk as Buffer;
          total += buf.length;
          if (total > 50 * 1024 * 1024) {
            return sendJson(413, { message: 'Payload too large' });
          }
          chunks.push(buf);
        }
        rawBody = Buffer.concat(chunks);
      }

      // Auth for the API surfaces (git smart HTTP is unauthenticated by design).
      const needsAuth = pathname === '/api/graphql' || pathname === '/mcp' || pathname.startsWith('/api/v3');
      if (needsAuth) {
        const auth = req.headers.authorization ?? '';
        const m = auth.match(/^Bearer (.+)$/);
        const ok = expectedToken === '' ? !!m : m !== null && m[1] === expectedToken;
        if (!ok) return sendJson(401, { message: 'Unauthorized' });
      }

      const host = req.headers.host ?? 'localhost';
      const requestUrl = `http://${host}${pathname}`;
      const apiBase = `http://${host}/api/v3`;

      // REST v3
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        const restPath = pathname === '/api/v3' ? '' : pathname.slice('/api/v3/'.length);
        const segments = restPath === '' ? [] : restPath.split('/').filter((s) => s.length > 0);
        const result = handleRest(forge, method, segments, url.searchParams, rawBody, requestUrl, apiBase);
        if (result === null) return sendJson(404, { message: 'Not Found' });
        return send(result.status, result.contentType, result.body, result.headers);
      }

      // GraphQL
      if (pathname === '/api/graphql') {
        if (method !== 'POST') return sendJson(405, { message: 'Method Not Allowed' });
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawBody.toString('utf8'));
        } catch {
          return sendJson(400, { errors: [{ message: 'Request body is not valid JSON' }] });
        }
        if (Array.isArray(parsed)) {
          const out = parsed.map((item) => {
            const q = (item as Record<string, unknown>).query;
            const vars = ((item as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
            if (typeof q !== 'string') return { data: null, errors: [{ message: 'missing query' }] };
            return executor.execute(q, vars);
          });
          return sendJson(200, out);
        }
        const obj = parsed as Record<string, unknown>;
        const q = obj.query;
        const vars = (obj.variables ?? {}) as Record<string, unknown>;
        if (typeof q !== 'string') return sendJson(400, { errors: [{ message: 'missing query' }] });
        return sendJson(200, executor.execute(q, vars));
      }

      // MCP
      if (pathname === '/mcp') {
        const result = handleMcp(forge, method, rawBody);
        return send(result.status, result.contentType, result.body, result.headers);
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const service = gitMatch[3];
        const gitProtocol = req.headers['git-protocol'];
        if (service === 'info/refs' && method === 'GET') {
          const result = handleInfoRefs(forge, owner, repoName, url.searchParams.get('service') ?? undefined, typeof gitProtocol === 'string' ? gitProtocol : undefined);
          return send(result.status, result.contentType, result.body);
        }
        if (service === 'git-upload-pack' && method === 'POST') {
          const result = handleUploadPack(forge, owner, repoName, typeof gitProtocol === 'string' ? gitProtocol : undefined, rawBody);
          return send(result.status, result.contentType, result.body);
        }
        if (service === 'git-receive-pack' && method === 'POST') {
          const result = handleReceivePack(forge, owner, repoName, rawBody);
          return send(result.status, result.contentType, result.body);
        }
        return sendJson(404, { message: 'Not Found' });
      }

      return sendJson(404, { message: 'Not Found' });
    } catch (err) {
      process.stderr.write(`[app] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) {
        sendJson(500, { message: 'Internal Server Error' });
      } else {
        res.end();
      }
    }
  });
  return server;
}
