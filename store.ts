// store.ts — in-memory forge state: repos, git objects, refs, issues, PRs,
// labels, comments. Deterministic logical clock for server-created commits.
import {
  putObject,
  getObject,
  parseCommit,
  parseTree,
  buildCommit,
  flattenTree,
  treeFromFiles,
  reachable,
  mergeBase,
  threeWayMerge,
  diffTrees,
  peelToCommit,
  isSha40,
  ZERO_OID,
} from './gitproto.ts';
import type { GitObject } from './gitproto.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
const EPOCH = 1735689600;

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
}

export class Repo {
  id: number;
  name: string;
  owner: string = VIEWER_LOGIN;
  description: string;
  private: boolean;
  defaultBranch: string = DEFAULT_BRANCH;
  /** Bumped on every mutation to objects or refs; used to key caches. */
  version = 0;
  objects: Map<string, GitObject> = new Map();
  refs: Map<string, string> = new Map();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  labels: Map<string, Label> = new Map();
  nextIssue = 1;
  nextPull = 1;
  nextCommentId = 1;
  createdSeq: number;

  constructor(id: number, name: string, description: string, priv: boolean, seq: number) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.private = priv;
    this.createdSeq = seq;
  }
}

export interface OpResult<T> {
  ok: boolean;
  value?: T;
  status?: number;
  message?: string;
}

function ok<T>(value: T): OpResult<T> {
  return { ok: true, value };
}
function fail<T>(status: number, message: string): OpResult<T> {
  return { ok: false, status, message };
}

export class Forge {
  repos: Map<string, Repo> = new Map();
  reposById: Map<number, Repo> = new Map();
  private repoSeq = 1;
  private issueSeq = 1;
  private pullSeq = 1;
  private commentSeq = 1;
  private seq = 1;
  private clock = EPOCH;

  nextTimestamp(): number {
    return this.clock++;
  }

  isoNow(): string {
    return new Date(this.nextTimestamp() * 1000).toISOString();
  }

  authorIdent(ts: number): string {
    return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  }

  // ------------------------------------------------------------ repos

  createRepo(name: string, description: string, priv: boolean): OpResult<Repo> {
    if (!name || typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
      return fail(422, 'Validation Failed: name is required');
    }
    if (this.repos.has(name)) {
      return fail(422, 'Repository creation failed: name already exists on this account');
    }
    const repo = new Repo(this.repoSeq++, name, description ?? '', !!priv, this.seq++);
    this.repos.set(name, repo);
    this.reposById.set(repo.id, repo);
    return ok(repo);
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  deleteRepo(name: string): boolean {
    const repo = this.repos.get(name);
    if (!repo) return false;
    this.repos.delete(name);
    this.reposById.delete(repo.id);
    return true;
  }

  // ----------------------------------------------------------- global ids

  globalId(kind: string, ...parts: (string | number)[]): string {
    return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
  }

  resolveGlobalId(id: string): {
    kind: string;
    repo?: Repo;
    issue?: Issue;
    pull?: Pull;
    comment?: Comment;
  } | null {
    let text: string;
    try {
      text = Buffer.from(id, 'base64').toString('utf8');
    } catch {
      return null;
    }
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0];
    if (kind === 'Repository' && parts.length === 2) {
      const repo = this.reposById.get(Number(parts[1]));
      return repo ? { kind, repo } : null;
    }
    if (kind === 'Issue' && parts.length === 3) {
      const repo = this.reposById.get(Number(parts[1]));
      const issue = repo?.issues.find((i) => i.number === Number(parts[2]));
      return repo && issue ? { kind, repo, issue } : null;
    }
    if (kind === 'PullRequest' && parts.length === 3) {
      const repo = this.reposById.get(Number(parts[1]));
      const pull = repo?.pulls.find((p) => p.number === Number(parts[2]));
      return repo && pull ? { kind, repo, pull } : null;
    }
    if (kind === 'IssueComment' && parts.length === 4) {
      const repo = this.reposById.get(Number(parts[1]));
      const issue = repo?.issues.find((i) => i.number === Number(parts[2]));
      const comment = issue?.comments.find((c) => c.id === Number(parts[3]));
      return repo && issue && comment ? { kind, repo, issue, comment } : null;
    }
    return null;
  }

  // ------------------------------------------------------------ labels

  createLabel(repo: Repo, name: string, color: string, description: string): OpResult<Label> {
    if (!name) return fail(422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) return fail(422, 'Validation Failed: label already exists');
    const label: Label = { name, color: color || 'ededed', description: description || '' };
    repo.labels.set(name, label);
    return ok(label);
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): OpResult<Issue> {
    if (!title) return fail(422, 'Validation Failed: title is required');
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return fail(422, `Validation Failed: label "${name}" does not exist`);
      labels.push(label);
    }
    const seq = this.seq++;
    const issue: Issue = {
      id: this.issueSeq++,
      number: repo.nextIssue++,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.issues.push(issue);
    return ok(issue);
  }

  getIssue(repo: Repo, n: number): Issue | undefined {
    return repo.issues.find((i) => i.number === n);
  }

  listIssues(
    repo: Repo,
    opts: { state?: string; sort?: string; direction?: string },
  ): Issue[] {
    let list = [...repo.issues];
    const state = opts.state ?? 'open';
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    const field = (opts.sort ?? 'created') === 'comments' ? 'comments' : (opts.sort ?? 'created') === 'updated' ? 'updated' : 'created';
    const dir = (opts.direction ?? 'desc') === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      const av = field === 'comments' ? a.comments.length : field === 'updated' ? a.updatedSeq : a.createdSeq;
      const bv = field === 'comments' ? b.comments.length : field === 'updated' ? b.updatedSeq : b.createdSeq;
      return (av - bv) * dir;
    });
    return list;
  }

  patchIssue(
    repo: Repo,
    n: number,
    patch: { state?: string; title?: string; body?: string; labels?: string[] },
  ): OpResult<Issue> {
    const issue = this.getIssue(repo, n);
    if (!issue) return fail(404, 'Not Found');
    if (patch.state !== undefined) {
      if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.labels !== undefined) {
      const labels: Label[] = [];
      for (const name of patch.labels) {
        const label = repo.labels.get(name);
        if (!label) return fail(422, `Validation Failed: label "${name}" does not exist`);
        labels.push(label);
      }
      issue.labels = labels;
    }
    issue.updatedSeq = this.seq++;
    return ok(issue);
  }

  createComment(repo: Repo, n: number, body: string): OpResult<Comment> {
    const issue = this.getIssue(repo, n);
    if (!issue) return fail(404, 'Not Found');
    if (!body) return fail(422, 'Validation Failed: body is required');
    const comment: Comment = { id: this.commentSeq++, body, createdSeq: this.seq++ };
    issue.comments.push(comment);
    issue.updatedSeq = this.seq++;
    return ok(comment);
  }

  // -------------------------------------------------------------- pulls

  createPull(repo: Repo, title: string, body: string, head: string, base: string): OpResult<Pull> {
    if (!title) return fail(422, 'Validation Failed: title is required');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha) return fail(422, `Validation Failed: head branch "${head}" does not exist`);
    if (!baseSha) return fail(422, `Validation Failed: base branch "${base}" does not exist`);
    const seq = this.seq++;
    const pull: Pull = {
      id: this.pullSeq++,
      number: repo.nextPull++,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.pulls.push(pull);
    return ok(pull);
  }

  getPull(repo: Repo, n: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === n);
  }

  listPulls(repo: Repo, state: string): Pull[] {
    let list = [...repo.pulls];
    const s = state ?? 'open';
    if (s === 'open') list = list.filter((p) => p.state === 'open');
    else if (s === 'closed') list = list.filter((p) => p.state === 'closed');
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    return list;
  }

  pullFiles(repo: Repo, n: number): OpResult<{ filename: string; status: string; additions: number; deletions: number; changes: number }[]> {
    const pull = this.getPull(repo, n);
    if (!pull) return fail(404, 'Not Found');
    const base = mergeBase(repo, pull.baseSha, pull.headSha);
    const baseTree = base ? parseCommit(getObject(repo, base)!.data).tree : '';
    const headTree = parseCommit(getObject(repo, pull.headSha)!.data).tree;
    return ok(diffTrees(repo, baseTree, headTree));
  }

  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    const base = mergeBase(repo, pull.baseSha, pull.headSha);
    const baseTree = base ? parseCommit(getObject(repo, base)!.data).tree : '';
    const oursTree = parseCommit(getObject(repo, pull.baseSha)!.data).tree;
    const theirsTree = parseCommit(getObject(repo, pull.headSha)!.data).tree;
    const res = threeWayMerge(repo, baseTree, oursTree, theirsTree);
    return res.conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  mergePull(repo: Repo, n: number, method: string): OpResult<{ sha: string; message: string }> {
    const pull = this.getPull(repo, n);
    if (!pull) return fail(404, 'Not Found');
    if (pull.state !== 'open' || pull.merged) {
      return fail(405, 'Pull request is not mergeable');
    }
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headSha || !baseSha) return fail(422, 'Validation Failed: branch does not exist');
    pull.headSha = headSha;
    pull.baseSha = baseSha;
    const base = mergeBase(repo, baseSha, headSha);
    const baseTree = base ? parseCommit(getObject(repo, base)!.data).tree : '';
    const oursTree = parseCommit(getObject(repo, baseSha)!.data).tree;
    const theirsTree = parseCommit(getObject(repo, headSha)!.data).tree;
    const m = (method ?? 'squash').toLowerCase();
    const ts = this.nextTimestamp();
    const ident = this.authorIdent(ts);
    let mergeSha: string;
    let message: string;
    if (m === 'merge') {
      const res = threeWayMerge(repo, baseTree, oursTree, theirsTree);
      if (res.conflict || !res.treeOid) return fail(405, 'Merge conflict');
      message = `Merge pull request #${pull.number} from ${pull.headRef}`;
      mergeSha = putObject(repo, 'commit', buildCommit(res.treeOid, [baseSha, headSha], ident, ident, message));
    } else if (m === 'rebase') {
      // Head-only commits, oldest first.
      const baseReachable = reachable(repo, [baseSha]);
      const headCommits: string[] = [];
      const seen = new Set<string>();
      const queue: string[] = [headSha];
      while (queue.length > 0) {
        const oid = queue.shift()!;
        if (seen.has(oid) || baseReachable.has(oid)) continue;
        seen.add(oid);
        const obj = getObject(repo, oid);
        if (!obj || obj.type !== 'commit') continue;
        headCommits.push(oid);
        queue.push(...parseCommit(obj.data).parents);
      }
      headCommits.reverse();
      let current = baseSha;
      let last = baseSha;
      for (const oid of headCommits) {
        const c = parseCommit(getObject(repo, oid)!.data);
        const parentTree = c.parents.length > 0 ? parseCommit(getObject(repo, c.parents[0])!.data).tree : '';
        const currentTree = parseCommit(getObject(repo, current)!.data).tree;
        const res = threeWayMerge(repo, parentTree, currentTree, c.tree);
        if (res.conflict || !res.treeOid) return fail(405, 'Merge conflict');
        const cts = this.nextTimestamp();
        const cIdent = this.authorIdent(cts);
        last = putObject(repo, 'commit', buildCommit(res.treeOid, [current], c.author || cIdent, cIdent, c.message));
        current = last;
      }
      mergeSha = last;
      message = `Rebase pull request #${pull.number}`;
    } else {
      // squash (default)
      const res = threeWayMerge(repo, baseTree, oursTree, theirsTree);
      if (res.conflict || !res.treeOid) return fail(405, 'Merge conflict');
      message = pull.body ? `${pull.title}\n\n${pull.body}` : pull.title;
      mergeSha = putObject(repo, 'commit', buildCommit(res.treeOid, [baseSha], ident, ident, message));
    }
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.baseSha = mergeSha;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(ts * 1000).toISOString();
    pull.mergeCommitSha = mergeSha;
    pull.updatedSeq = this.seq++;
    repo.version++;
    return ok({ sha: mergeSha, message });
  }

  // -------------------------------------------------------------- refs

  listBranches(repo: Repo): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of [...repo.refs.entries()].sort()) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    return out;
  }

  createRef(repo: Repo, ref: string, sha: string): OpResult<{ ref: string; sha: string }> {
    if (!ref.startsWith('refs/')) return fail(422, 'Validation Failed: ref must start with refs/');
    if (!isSha40(sha) || !getObject(repo, sha)) return fail(422, 'Validation Failed: object does not exist');
    if (repo.refs.has(ref)) return fail(422, 'Validation Failed: reference already exists');
    repo.refs.set(ref, sha);
    repo.version++;
    return ok({ ref, sha });
  }

  /** Resolve a ref string (branch name, full ref, or commit sha) to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isSha40(ref)) {
      const obj = getObject(repo, ref);
      return obj && obj.type === 'commit' ? ref : null;
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    return repo.refs.get(`refs/heads/${ref}`) ?? null;
  }

  listCommits(repo: Repo, ref: string): OpResult<{ sha: string; message: string }[]> {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return fail(404, 'Not Found');
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = getObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      out.push({ sha: oid, message: c.message });
      // Push parents in reverse so first parent is visited first.
      for (let i = c.parents.length - 1; i >= 0; i--) stack.push(c.parents[i]);
    }
    return ok(out);
  }

  // ----------------------------------------------------------- contents

  putContent(
    repo: Repo,
    path: string,
    body: { message?: string; content?: string; branch?: string; sha?: string },
  ): OpResult<{ content: { name: string; path: string; sha: string; size: number }; commit: { sha: string }; status: number }> {
    if (typeof body.content !== 'string') return fail(422, 'Validation Failed: content is required');
    let contentBytes: Buffer;
    try {
      contentBytes = Buffer.from(body.content.replace(/\s/g, ''), 'base64');
    } catch {
      return fail(422, 'Validation Failed: content is not valid base64');
    }
    const branch = body.branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    let tip = repo.refs.get(refName);
    let parentTree = '';
    if (tip) {
      parentTree = parseCommit(getObject(repo, tip)!.data).tree;
    } else if (branch !== repo.defaultBranch) {
      // New branch from default branch tip.
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip) {
        tip = defaultTip;
        parentTree = parseCommit(getObject(repo, defaultTip)!.data).tree;
      }
    }
    const files = parentTree ? flattenTree(repo, parentTree) : new Map<string, { mode: string; oid: string }>();
    const existing = files.get(path);
    if (existing) {
      if (!body.sha) return fail(422, 'Validation Failed: sha is required to update a file');
      if (body.sha !== existing.oid) return fail(409, 'Conflict: sha does not match the current blob');
    }
    const blobOid = putObject(repo, 'blob', contentBytes);
    files.set(path, { mode: '100644', oid: blobOid });
    const treeOid = treeFromFiles(repo, files);
    const ts = this.nextTimestamp();
    const ident = this.authorIdent(ts);
    const message = body.message ?? `Update ${path}`;
    const parents = tip ? [tip] : [];
    const commitOid = putObject(repo, 'commit', buildCommit(treeOid, parents, ident, ident, message));
    repo.refs.set(refName, commitOid);
    repo.version++;
    const name = path.split('/').pop() ?? path;
    return ok({
      content: { name, path, sha: blobOid, size: contentBytes.length },
      commit: { sha: commitOid },
      status: existing ? 200 : 201,
    });
  }

  getContent(
    repo: Repo,
    path: string,
    ref: string | undefined,
  ): OpResult<
    | { type: 'file'; name: string; path: string; sha: string; size: number; content: string }
    | { type: 'dir'; entries: { type: string; name: string; path: string; sha: string }[] }
  > {
    const tip = this.resolveRef(repo, ref ?? repo.defaultBranch);
    if (!tip) return fail(404, 'Not Found');
    const treeOid = parseCommit(getObject(repo, tip)!.data).tree;
    if (!path) {
      // Root listing.
      const entries = this.listTreeEntries(repo, treeOid, '');
      return ok({ type: 'dir', entries });
    }
    const parts = path.split('/');
    let currentTree = treeOid;
    for (let i = 0; i < parts.length; i++) {
      const obj = getObject(repo, currentTree);
      if (!obj || obj.type !== 'tree') return fail(404, 'Not Found');
      const entries = flattenTreeDirect(repo, currentTree);
      const entry = entries.get(parts[i]);
      if (!entry) return fail(404, 'Not Found');
      if (i === parts.length - 1) {
        if (entry.mode === '40000') {
          return ok({ type: 'dir', entries: this.listTreeEntries(repo, entry.oid, path) });
        }
        const blob = getObject(repo, entry.oid);
        if (!blob) return fail(404, 'Not Found');
        return ok({
          type: 'file',
          name: parts[i],
          path,
          sha: entry.oid,
          size: blob.data.length,
          content: blob.data.toString('base64'),
        });
      }
      if (entry.mode !== '40000') return fail(404, 'Not Found');
      currentTree = entry.oid;
    }
    return fail(404, 'Not Found');
  }

  listTreeEntries(repo: Repo, treeOid: string, prefix: string): { type: string; name: string; path: string; sha: string }[] {
    const entries = flattenTreeDirect(repo, treeOid);
    const out: { type: string; name: string; path: string; sha: string }[] = [];
    for (const [name, e] of [...entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      out.push({
        type: e.mode === '40000' ? 'dir' : 'file',
        name,
        path: prefix ? `${prefix}/${name}` : name,
        sha: e.oid,
      });
    }
    return out;
  }

  deleteContent(
    repo: Repo,
    path: string,
    body: { message?: string; sha?: string; branch?: string },
  ): OpResult<{ sha: string }> {
    const branch = body.branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    if (!tip) return fail(404, 'Not Found');
    const treeOid = parseCommit(getObject(repo, tip)!.data).tree;
    const files = flattenTree(repo, treeOid);
    const existing = files.get(path);
    if (!existing) return fail(404, 'Not Found');
    if (body.sha && body.sha !== existing.oid) return fail(409, 'Conflict: sha does not match the current blob');
    files.delete(path);
    const newTree = treeFromFiles(repo, files);
    const ts = this.nextTimestamp();
    const ident = this.authorIdent(ts);
    const message = body.message ?? `Delete ${path}`;
    const commitOid = putObject(repo, 'commit', buildCommit(newTree, [tip], ident, ident, message));
    repo.refs.set(refName, commitOid);
    repo.version++;
    return ok({ sha: commitOid });
  }

  // ------------------------------------------------------- object store

  /** Peel a tag to its target commit (for ref advertisement). */
  peelRefTarget(repo: Repo, oid: string): string | null {
    const obj = getObject(repo, oid);
    if (!obj) return null;
    if (obj.type !== 'tag') return null;
    const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
    return m ? m[1] : null;
  }

  /** Default branch tip commit oid (or null when unborn). */
  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
}

/** Direct children of a tree object (one level, no recursion). */
export function flattenTreeDirect(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) out.set(e.name, { mode: e.mode, oid: e.oid });
  return out;
}

export { ZERO_OID };
