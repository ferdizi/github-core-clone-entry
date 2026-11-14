// mcp.ts — MCP endpoint (JSON-RPC 2.0 Streamable HTTP) at /mcp.
// Implements both the modern 2026-07-28 server/discover flow and the
// legacy 2025-11-25 initialize flow. Auth is enforced by app.ts.
import { Forge, VIEWER_LOGIN } from './store.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Repository owner login (defaults to the authenticated user)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Pull request state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
];

function jsonResult(status: number, obj: unknown): HttpResult {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify(obj), 'utf8') };
}

function rpcResult(id: unknown, result: unknown): HttpResult {
  return jsonResult(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): HttpResult {
  return jsonResult(200, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolTextResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArgs(args: Record<string, unknown>, required: string[]): string | null {
  for (const key of required) {
    const v = args[key];
    if (v === undefined || v === null || v === '') return key;
  }
  return null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = String(args.owner ?? VIEWER_LOGIN);
  const repoName = String(args.repo ?? '');
  switch (name) {
    case 'create_repo': {
      const missing = missingArgs(args, ['name']);
      if (missing) return toolErrorResult(`Missing required argument: ${missing}`);
      const res = forge.createRepo(String(args.name), typeof args.description === 'string' ? args.description : '', args.private === true);
      if (!res.ok) return toolErrorResult(res.message!);
      return toolTextResult(repoJson(res.value!));
    }
    case 'get_repo': {
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing) return toolErrorResult(`Missing required argument: ${missing}`);
      if (owner !== VIEWER_LOGIN) return toolErrorResult('Repository not found');
      const repo = forge.getRepo(repoName);
      if (!repo) return toolErrorResult('Repository not found');
      return toolTextResult(repoJson(repo));
    }
    case 'create_issue': {
      const missing = missingArgs(args, ['owner', 'repo', 'title']);
      if (missing) return toolErrorResult(`Missing required argument: ${missing}`);
      if (owner !== VIEWER_LOGIN) return toolErrorResult('Repository not found');
      const repo = forge.getRepo(repoName);
      if (!repo) return toolErrorResult('Repository not found');
      const res = forge.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if (!res.ok) return toolErrorResult(res.message!);
      return toolTextResult(issueJson(forge, repo, res.value!));
    }
    case 'list_issues': {
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing) return toolErrorResult(`Missing required argument: ${missing}`);
      if (owner !== VIEWER_LOGIN) return toolErrorResult('Repository not found');
      const repo = forge.getRepo(repoName);
      if (!repo) return toolErrorResult('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'all';
      const issues = forge.listIssues(repo, { state });
      const list = issues.map((i) => issueJson(forge, repo, i));
      return { content: [{ type: 'text', text: JSON.stringify(list) }], structuredContent: { issues: list } };
    }
    case 'create_pull_request': {
      const missing = missingArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing) return toolErrorResult(`Missing required argument: ${missing}`);
      if (owner !== VIEWER_LOGIN) return toolErrorResult('Repository not found');
      const repo = forge.getRepo(repoName);
      if (!repo) return toolErrorResult('Repository not found');
      const res = forge.createPull(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        String(args.head),
        String(args.base),
      );
      if (!res.ok) return toolErrorResult(res.message!);
      return toolTextResult(pullJson(forge, repo, res.value!));
    }
    case 'merge_pull_request': {
      const missing = missingArgs(args, ['owner', 'repo', 'pull_number']);
      if (missing) return toolErrorResult(`Missing required argument: ${missing}`);
      if (owner !== VIEWER_LOGIN) return toolErrorResult('Repository not found');
      const repo = forge.getRepo(repoName);
      if (!repo) return toolErrorResult('Repository not found');
      const n = Number(args.pull_number);
      if (!Number.isInteger(n) || n < 1) return toolErrorResult('Invalid pull_number');
      const pull = forge.getPull(repo, n);
      if (!pull) return toolErrorResult('Pull request not found');
      const res = forge.mergePull(repo, n, 'squash');
      if (!res.ok) return toolErrorResult(res.message!);
      return toolTextResult({ merged: true, sha: res.value!.sha, number: n, state: 'closed' });
    }
    case 'get_issue': {
      const missing = missingArgs(args, ['owner', 'repo', 'issue_number']);
      if (missing) return toolErrorResult(`Missing required argument: ${missing}`);
      if (owner !== VIEWER_LOGIN) return toolErrorResult('Repository not found');
      const repo = forge.getRepo(repoName);
      if (!repo) return toolErrorResult('Repository not found');
      const n = Number(args.issue_number);
      const issue = forge.getIssue(repo, n);
      if (!issue) return toolErrorResult('Issue not found');
      return toolTextResult(issueJson(forge, repo, issue));
    }
    case 'list_pull_requests': {
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing) return toolErrorResult(`Missing required argument: ${missing}`);
      if (owner !== VIEWER_LOGIN) return toolErrorResult('Repository not found');
      const repo = forge.getRepo(repoName);
      if (!repo) return toolErrorResult('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'all';
      const pulls = forge.listPulls(repo, state);
      const list = pulls.map((p) => pullJson(forge, repo, p));
      return { content: [{ type: 'text', text: JSON.stringify(list) }], structuredContent: { pull_requests: list } };
    }
    default:
      return toolErrorResult(`Unknown tool: ${name}`);
  }
}

export function handleMcp(forge: Forge, method: string, rawBody: Buffer): HttpResult {
  if (method !== 'POST') {
    return jsonResult(405, { message: 'Method Not Allowed' });
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 'utf8'),
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = 'id' in req ? req.id : undefined;
  const isNotification = id === undefined;
  const m = req.method ?? '';
  if (m.startsWith('notifications/')) {
    return { status: 202, contentType: 'application/json', body: Buffer.alloc(0) };
  }
  if (m === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (m === 'initialize') {
    const params = (req.params ?? {}) as { protocolVersion?: string };
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    if (!SUPPORTED_VERSIONS.includes(offered)) {
      return rpcError(id, -32602, `Unsupported protocol version: ${offered}`);
    }
    return rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (m === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (m === 'tools/call') {
    const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!TOOLS.some((t) => t.name === toolName)) {
      return rpcError(id, -32602, `Unknown tool: ${toolName}`);
    }
    const result = callTool(forge, toolName, args);
    return rpcResult(id, result);
  }
  if (isNotification) {
    return { status: 202, contentType: 'application/json', body: Buffer.alloc(0) };
  }
  return rpcError(id, -32601, `Method not found: ${m}`);
}
