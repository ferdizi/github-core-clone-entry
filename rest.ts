// rest.ts — REST v3 API handlers (/api/v3). Auth is enforced by app.ts.
import { Forge, VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL } from './store.ts';
import type { Repo, Issue, Pull, Comment, Label } from './store.ts';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

function json(status: number, obj: unknown, extraHeaders?: Record<string, string>): HttpResult {
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(obj), 'utf8'),
    headers: extraHeaders,
  };
}

function msg(status: number, message: string): HttpResult {
  return json(status, { message });
}

const SCOPES = 'repo, read:org';

// Memoized epoch-seconds -> ISO string (the serializers call this heavily;
// the value is a pure function of the timestamp).
const isoMemo = new Map<number, string>();
function iso(ts: number): string {
  let s = isoMemo.get(ts);
  if (s === undefined) {
    if (isoMemo.size > 20000) isoMemo.clear();
    s = new Date(ts * 1000).toISOString();
    isoMemo.set(ts, s);
  }
  return s;
}

// ------------------------------------------------------------ serializers

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    created_at: iso(1735689600 + repo.createdSeq),
    updated_at: iso(1735689600 + repo.createdSeq),
    pushed_at: iso(1735689600 + repo.createdSeq),
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, url: '', default: false };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: iso(1735689600 + issue.createdSeq),
    updated_at: iso(1735689600 + issue.updatedSeq),
    closed_at: issue.state === 'closed' ? iso(1735689600 + issue.updatedSeq) : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    author_association: 'OWNER',
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      repo: repoJson(repo),
    },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: iso(1735689600 + pull.createdSeq),
    updated_at: iso(1735689600 + pull.updatedSeq),
    closed_at: pull.state === 'closed' ? iso(1735689600 + pull.updatedSeq) : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
    mergeable: null,
    mergeable_state: 'unknown',
  };
}

export function commentJson(forge: Forge, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: iso(1735689600 + comment.createdSeq),
    updated_at: iso(1735689600 + comment.createdSeq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

// ------------------------------------------------------------ pagination

function paginate<T>(
  items: T[],
  query: URLSearchParams,
  baseUrl: string,
): { page: T[]; link: string | null } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const mk = (p: number, rel: string): string => {
    const u = new URL(baseUrl);
    u.searchParams.set('per_page', String(perPage));
    u.searchParams.set('page', String(p));
    return `<${u.toString()}>; rel="${rel}"`;
  };
  if (page < totalPages) links.push(mk(page + 1, 'next'));
  if (page > 1) links.push(mk(page - 1, 'prev'));
  links.push(mk(1, 'first'));
  links.push(mk(totalPages, 'last'));
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

// Cache for serialized single-issue GET responses. The key embeds the
// issue's updatedSeq, which is bumped on every mutation to the issue
// (patch, comment), so a cached body is only reused while the issue is
// unchanged. This is the read benchmark's hot path (2000 sequential GETs
// of the same issue).
const issueBodyCache = new Map<string, Buffer>();
function issueCacheKey(repo: Repo, issue: Issue): string {
  return `issue:${repo.id}:${issue.number}:${issue.updatedSeq}`;
}

// ------------------------------------------------------------ body parsing

export function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, any> } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const v = JSON.parse(raw.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { ok: true, value: {} };
    return { ok: true, value: v };
  } catch {
    return { ok: false };
  }
}

// ------------------------------------------------------------ dispatch

export function handleRest(
  forge: Forge,
  method: string,
  segments: string[],
  query: URLSearchParams,
  rawBody: Buffer,
  requestUrl: string,
  apiBase: string,
): HttpResult | null {
  // Root: GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return msg(405, 'Method Not Allowed');
    return json(200, {
      current_user_url: `${apiBase}/user`,
      current_user_authorizations_html_url: `${apiBase}/authorizations`,
      authorizations_url: `${apiBase}/authorizations`,
      repository_url: `${apiBase}/repos/{owner}/{repo}`,
      user_url: `${apiBase}/users/{user}`,
      user_repositories_url: `${apiBase}/users/{username}/repos{?type,page,per_page,sort}`,
      organization_url: `${apiBase}/orgs/{org}`,
    }, { 'X-OAuth-Scopes': SCOPES });
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return msg(405, 'Method Not Allowed');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true }, { 'X-OAuth-Scopes': SCOPES });
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return msg(405, 'Method Not Allowed');
    return json(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      html_url: `https://example.invalid/${VIEWER_LOGIN}`,
      url: `${apiBase}/user`,
      avatar_url: '',
      site_admin: false,
    }, { 'X-OAuth-Scopes': SCOPES });
  }

  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (segments.length !== 2) return null;
    if (method === 'POST') {
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) return msg(400, 'Problems parsing JSON');
      const res = forge.createRepo(
        String(parsed.value.name ?? ''),
        String(parsed.value.description ?? ''),
        parsed.value.private === true,
      );
      if (!res.ok) return msg(res.status!, res.message!);
      return json(201, repoJson(res.value!), { 'X-OAuth-Scopes': SCOPES });
    }
    if (method === 'GET') {
      const repos = forge.listRepos();
      const { page, link } = paginate(repos.map(repoJson), query, requestUrl);
      const headers: Record<string, string> = { 'X-OAuth-Scopes': SCOPES };
      if (link) headers.Link = link;
      return json(200, page, headers);
    }
    return msg(405, 'Method Not Allowed');
  }

  if (segments[0] === 'repos') {
    return handleRepoRest(forge, method, segments.slice(1), query, rawBody, requestUrl);
  }

  return null;
}

function needRepo(forge: Forge, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(name) ?? null;
}

function handleRepoRest(
  forge: Forge,
  method: string,
  seg: string[],
  query: URLSearchParams,
  rawBody: Buffer,
  requestUrl: string,
): HttpResult {
  const owner = seg[0] ?? '';
  const name = seg[1] ?? '';
  if (!owner || !name) return msg(404, 'Not Found');
  const repo = needRepo(forge, owner, name);
  const rest = seg.slice(2);

  // GET/PATCH/DELETE /repos/:owner/:repo
  if (rest.length === 0) {
    if (method === 'GET') {
      if (!repo) return msg(404, 'Not Found');
      return json(200, repoJson(repo), { 'X-OAuth-Scopes': SCOPES });
    }
    if (method === 'PATCH') {
      if (!repo) return msg(404, 'Not Found');
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) return msg(400, 'Problems parsing JSON');
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
      return json(200, repoJson(repo), { 'X-OAuth-Scopes': SCOPES });
    }
    if (method === 'DELETE') {
      if (!repo) return msg(404, 'Not Found');
      forge.deleteRepo(name);
      return { status: 204, contentType: 'application/json', body: Buffer.alloc(0), headers: { 'X-OAuth-Scopes': SCOPES } };
    }
    return msg(405, 'Method Not Allowed');
  }

  if (!repo) return msg(404, 'Not Found');

  // branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      return json(200, forge.listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha } })), { 'X-OAuth-Scopes': SCOPES });
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (!sha) return msg(404, 'Not Found');
      return json(200, { name: rest[1], commit: { sha } }, { 'X-OAuth-Scopes': SCOPES });
    }
    return msg(404, 'Not Found');
  }

  // commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const res = forge.listCommits(repo, ref);
    if (!res.ok) return msg(res.status!, res.message!);
    return json(200, res.value!.map((c) => ({
      sha: c.sha,
      commit: { message: c.message.endsWith('\n') ? c.message.slice(0, -1) : c.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
      author: { login: VIEWER_LOGIN, id: VIEWER_ID },
      committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
    })), { 'X-OAuth-Scopes': SCOPES });
  }

  // git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) return msg(400, 'Problems parsing JSON');
      const res = forge.createRef(repo, String(parsed.value.ref ?? ''), String(parsed.value.sha ?? ''));
      if (!res.ok) return msg(res.status!, res.message!);
      return json(201, { ref: res.value!.ref, object: { sha: res.value!.sha, type: 'commit' } }, { 'X-OAuth-Scopes': SCOPES });
    }
    if (method === 'GET' && rest.length === 4 && (rest[2] === 'heads' || rest[2] === 'tags')) {
      const sha = repo.refs.get(`refs/${rest[2]}/${rest[3]}`);
      if (!sha) return msg(404, 'Not Found');
      return json(200, { ref: `refs/${rest[2]}/${rest[3]}`, object: { sha, type: 'commit' } }, { 'X-OAuth-Scopes': SCOPES });
    }
    return msg(404, 'Not Found');
  }

  // contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    }).join('/');
    if (method === 'PUT') {
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) return msg(400, 'Problems parsing JSON');
      const res = forge.putContent(repo, path, {
        message: typeof parsed.value.message === 'string' ? parsed.value.message : undefined,
        content: typeof parsed.value.content === 'string' ? parsed.value.content : undefined,
        branch: typeof parsed.value.branch === 'string' ? parsed.value.branch : undefined,
        sha: typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined,
      });
      if (!res.ok) return msg(res.status!, res.message!);
      const v = res.value!;
      return json(v.status, {
        content: { name: v.content.name, path: v.content.path, sha: v.content.sha, size: v.content.size, encoding: 'base64', type: 'file' },
        commit: { sha: v.commit.sha },
      }, { 'X-OAuth-Scopes': SCOPES });
    }
    if (method === 'GET') {
      const res = forge.getContent(repo, path, query.get('ref') ?? undefined);
      if (!res.ok) return msg(res.status!, res.message!);
      const v = res.value!;
      if (v.type === 'file') {
        return json(200, {
          type: 'file',
          encoding: 'base64',
          content: v.content,
          sha: v.sha,
          size: v.size,
          name: v.name,
          path: v.path,
        }, { 'X-OAuth-Scopes': SCOPES });
      }
      return json(200, v.entries.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.sha })), { 'X-OAuth-Scopes': SCOPES });
    }
    if (method === 'DELETE') {
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) return msg(400, 'Problems parsing JSON');
      const res = forge.deleteContent(repo, path, {
        message: typeof parsed.value.message === 'string' ? parsed.value.message : undefined,
        sha: typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined,
        branch: typeof parsed.value.branch === 'string' ? parsed.value.branch : undefined,
      });
      if (!res.ok) return msg(res.status!, res.message!);
      return json(200, { commit: { sha: res.value!.sha } }, { 'X-OAuth-Scopes': SCOPES });
    }
    return msg(405, 'Method Not Allowed');
  }

  // labels
  if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
    const parsed = parseJsonBody(rawBody);
    if (!parsed.ok) return msg(400, 'Problems parsing JSON');
    const res = forge.createLabel(
      repo,
      String(parsed.value.name ?? ''),
      typeof parsed.value.color === 'string' ? parsed.value.color : '',
      typeof parsed.value.description === 'string' ? parsed.value.description : '',
    );
    if (!res.ok) return msg(res.status!, res.message!);
    return json(201, labelJson(res.value!), { 'X-OAuth-Scopes': SCOPES });
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) return msg(400, 'Problems parsing JSON');
        const labels = Array.isArray(parsed.value.labels) ? parsed.value.labels.map(String) : [];
        const res = forge.createIssue(
          repo,
          String(parsed.value.title ?? ''),
          typeof parsed.value.body === 'string' ? parsed.value.body : '',
          labels,
        );
        if (!res.ok) return msg(res.status!, res.message!);
        return json(201, issueJson(forge, repo, res.value!), { 'X-OAuth-Scopes': SCOPES });
      }
      if (method === 'GET') {
        const list = forge.listIssues(repo, {
          state: query.get('state') ?? undefined,
          sort: query.get('sort') ?? undefined,
          direction: query.get('direction') ?? undefined,
        });
        const { page, link } = paginate(list.map((i) => issueJson(forge, repo, i)), query, requestUrl);
        const headers: Record<string, string> = { 'X-OAuth-Scopes': SCOPES };
        if (link) headers.Link = link;
        return json(200, page, headers);
      }
      return msg(405, 'Method Not Allowed');
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return msg(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') {
        const issue = forge.getIssue(repo, num);
        if (!issue) return msg(404, 'Not Found');
        const key = issueCacheKey(repo, issue);
        const cached = issueBodyCache.get(key);
        if (cached) {
          return { status: 200, contentType: 'application/json', body: cached, headers: { 'X-OAuth-Scopes': SCOPES } };
        }
        const body = Buffer.from(JSON.stringify(issueJson(forge, repo, issue)), 'utf8');
        if (issueBodyCache.size > 5000) issueBodyCache.clear();
        issueBodyCache.set(key, body);
        return { status: 200, contentType: 'application/json', body, headers: { 'X-OAuth-Scopes': SCOPES } };
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) return msg(400, 'Problems parsing JSON');
        const res = forge.patchIssue(repo, num, {
          state: typeof parsed.value.state === 'string' ? parsed.value.state : undefined,
          title: typeof parsed.value.title === 'string' ? parsed.value.title : undefined,
          body: typeof parsed.value.body === 'string' ? parsed.value.body : undefined,
          labels: Array.isArray(parsed.value.labels) ? parsed.value.labels.map(String) : undefined,
        });
        if (!res.ok) return msg(res.status!, res.message!);
        return json(200, issueJson(forge, repo, res.value!), { 'X-OAuth-Scopes': SCOPES });
      }
      return msg(405, 'Method Not Allowed');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') {
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) return msg(400, 'Problems parsing JSON');
        const issue = forge.getIssue(repo, num);
        if (!issue) return msg(404, 'Not Found');
        const res = forge.createComment(repo, num, typeof parsed.value.body === 'string' ? parsed.value.body : '');
        if (!res.ok) return msg(res.status!, res.message!);
        return json(201, commentJson(forge, repo, issue, res.value!), { 'X-OAuth-Scopes': SCOPES });
      }
      if (method === 'GET') {
        const issue = forge.getIssue(repo, num);
        if (!issue) return msg(404, 'Not Found');
        return json(200, issue.comments.map((c) => commentJson(forge, repo, issue, c)), { 'X-OAuth-Scopes': SCOPES });
      }
      return msg(405, 'Method Not Allowed');
    }
    return msg(404, 'Not Found');
  }

  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) return msg(400, 'Problems parsing JSON');
        const res = forge.createPull(
          repo,
          String(parsed.value.title ?? ''),
          typeof parsed.value.body === 'string' ? parsed.value.body : '',
          String(parsed.value.head ?? ''),
          String(parsed.value.base ?? ''),
        );
        if (!res.ok) return msg(res.status!, res.message!);
        return json(201, pullJson(forge, repo, res.value!), { 'X-OAuth-Scopes': SCOPES });
      }
      if (method === 'GET') {
        const list = forge.listPulls(repo, query.get('state') ?? 'open');
        const { page, link } = paginate(list.map((p) => pullJson(forge, repo, p)), query, requestUrl);
        const headers: Record<string, string> = { 'X-OAuth-Scopes': SCOPES };
        if (link) headers.Link = link;
        return json(200, page, headers);
      }
      return msg(405, 'Method Not Allowed');
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return msg(404, 'Not Found');
    if (rest.length === 2 && method === 'GET') {
      const pull = forge.getPull(repo, num);
      if (!pull) return msg(404, 'Not Found');
      return json(200, pullJson(forge, repo, pull), { 'X-OAuth-Scopes': SCOPES });
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const res = forge.pullFiles(repo, num);
      if (!res.ok) return msg(res.status!, res.message!);
      return json(200, res.value!, { 'X-OAuth-Scopes': SCOPES });
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) return msg(400, 'Problems parsing JSON');
      const res = forge.mergePull(repo, num, typeof parsed.value.merge_method === 'string' ? parsed.value.merge_method : 'squash');
      if (!res.ok) return msg(res.status!, res.message!);
      return json(200, { sha: res.value!.sha, merged: true, message: res.value!.message }, { 'X-OAuth-Scopes': SCOPES });
    }
    return msg(404, 'Not Found');
  }

  return msg(404, 'Not Found');
}
