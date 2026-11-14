// graphql.ts — hand-written GraphQL parser + executor for the fixed set of
// documents the conformance suite sends. Stdlib only.
import { Forge, VIEWER_LOGIN, VIEWER_ID } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selectionSet: Selection[] | null;
}

interface FragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selectionSet: Selection[];
}

type Selection = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selectionSet: Selection[];
}

type Token =
  | { t: 'name'; v: string }
  | { t: 'string'; v: string }
  | { t: 'int'; v: string }
  | { t: 'float'; v: string }
  | { t: 'punct'; v: string }
  | { t: 'spread'; v: string }
  | { t: 'eof' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ t: 'spread', v: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      tokens.push({ t: 'punct', v: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ t: 'string', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const num = src.slice(i, j);
      tokens.push(num.includes('.') ? { t: 'float', v: num } : { t: 'int', v: num });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`graphql: unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ t: 'eof' });
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expectPunct(v: string): void {
    const tok = this.next();
    if (tok.t !== 'punct' || tok.v !== v) throw new Error(`graphql: expected ${v}`);
  }
  private expectName(v?: string): string {
    const tok = this.next();
    if (tok.t !== 'name') throw new Error('graphql: expected name');
    if (v !== undefined && tok.v !== v) throw new Error(`graphql: expected ${v}`);
    return tok.v;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek().t !== 'eof') {
      const tok = this.peek();
      if (tok.t === 'punct' && tok.v === '{') {
        ops.push({ kind: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (tok.t === 'name' && (tok.v === 'query' || tok.v === 'mutation')) {
        const kind = this.next().v as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().t === 'name') name = this.next().v as string;
        if (this.peek().t === 'punct' && (this.peek() as { v: string }).v === '(') {
          this.skipVariableDefinitions();
        }
        ops.push({ kind, name, selectionSet: this.parseSelectionSet() });
      } else if (tok.t === 'name' && tok.v === 'fragment') {
        // Named fragment definition: parse and discard (not used by the suite).
        this.next();
        this.expectName();
        this.expectName('on');
        this.expectName();
        this.parseSelectionSet();
      } else {
        throw new Error(`graphql: unexpected token ${JSON.stringify(tok)}`);
      }
    }
    return ops;
  }

  private skipVariableDefinitions(): void {
    // Consume '(' ... ')' balancing nested parens.
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const tok = this.next();
      if (tok.t === 'eof') throw new Error('graphql: unterminated variable definitions');
      if (tok.t === 'punct' && tok.v === '(') depth++;
      if (tok.t === 'punct' && tok.v === ')') depth--;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (!(this.peek().t === 'punct' && (this.peek() as { v: string }).v === '}')) {
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): Selection {
    const tok = this.peek();
    if (tok.t === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().t === 'name' && (this.peek() as { v: string }).v === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().t === 'punct' && (this.peek() as { v: string }).v === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().t === 'punct' && (this.peek() as { v: string }).v === '(') {
      this.next();
      while (!(this.peek().t === 'punct' && (this.peek() as { v: string }).v === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selectionSet: Selection[] | null = null;
    if (this.peek().t === 'punct' && (this.peek() as { v: string }).v === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.t === 'punct' && tok.v === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (tok.t === 'string') return { kind: 'string', value: tok.v };
    if (tok.t === 'int') return { kind: 'int', value: parseInt(tok.v, 10) };
    if (tok.t === 'float') return { kind: 'float', value: parseFloat(tok.v) };
    if (tok.t === 'name') {
      if (tok.v === 'true') return { kind: 'boolean', value: true };
      if (tok.v === 'false') return { kind: 'boolean', value: false };
      if (tok.v === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.v };
    }
    if (tok.t === 'punct' && tok.v === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().t === 'punct' && (this.peek() as { v: string }).v === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (tok.t === 'punct' && tok.v === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().t === 'punct' && (this.peek() as { v: string }).v === '}')) {
        const k = this.expectName();
        this.expectPunct(':');
        fields[k] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`graphql: unexpected value token ${JSON.stringify(tok)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

// --------------------------------------------------------------- schema

const FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  User: new Set(['login', 'id', 'name', 'email', 'url']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'private', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'createdAt', 'updatedAt']),
  Ref: new Set(['name']),
  Issue: new Set(['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels']),
  PullRequest: new Set(['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url']),
  IssueConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PullRequestChangedFileConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PullRequestChangedFile: new Set(['path', 'additions', 'deletions', 'changes']),
  IssueComment: new Set(['id', 'body', 'author', 'createdAt']),
  IssueCommentEdge: new Set(['node', 'cursor']),
  AddIssueCommentPayload: new Set(['commentEdge']),
  CreateIssuePayload: new Set(['issue']),
  CloseIssuePayload: new Set(['issue']),
  CreatePullRequestPayload: new Set(['pullRequest']),
  MergePullRequestPayload: new Set(['pullRequest']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description']),
  __Field: new Set(['name', 'description', 'type', 'args']),
  __EnumValue: new Set(['name', 'description']),
  __InputValue: new Set(['name', 'description', 'type']),
};

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels', 'assignees', 'locked', 'viewerCanUpdate'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'author', 'createdAt', 'updatedAt', 'url', 'isDraft', 'reviewDecision'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'private', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'createdAt', 'updatedAt', 'homepageUrl', 'forkCount', 'stargazerCount'],
  User: ['login', 'id', 'name', 'email', 'url', 'avatarUrl'],
  Query: ['viewer', 'repository', 'node', 'search'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'PROJECT', 'TEAM'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function isEnumType(name: string): boolean {
  return name in ENUM_VALUES;
}

// -------------------------------------------------------------- executor

interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

export interface GqlResponse {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

export class GraphQLExecutor {
  private forge: Forge;
  constructor(forge: Forge) {
    this.forge = forge;
  }

  execute(query: string, variables: Record<string, unknown>): GqlResponse {
    let ops: Operation[];
    try {
      ops = new Parser(tokenize(query)).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: `GraphQL parse error: ${(e as Error).message}` }] };
    }
    if (ops.length === 0) return { data: null, errors: [{ message: 'empty document' }] };
    const op = ops[0];
    if (op.kind === 'mutation') return this.executeMutationOp(op, variables);
    const errors: { message: string }[] = [];
    const root: GqlObject = { __type: 'Query' };
    const data: Record<string, unknown> = {};
    for (const sel of op.selectionSet) {
      if (sel.kind === 'inlineFragment') {
        if (sel.typeCondition && sel.typeCondition !== 'Query') continue;
        Object.assign(data, this.executeSelections(root, sel.selectionSet, variables, errors));
      } else {
        const alias = sel.alias ?? sel.name;
        data[alias] = this.executeField(root, sel, variables, errors);
      }
    }
    const out: GqlResponse = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  }

  private executeMutationOp(op: Operation, variables: Record<string, unknown>): GqlResponse {
    return executeMutation(this.forge, this, op, variables);
  }

  executeSelections(
    obj: GqlObject,
    selections: Selection[],
    variables: Record<string, unknown>,
    errors: { message: string }[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'inlineFragment') {
        if (sel.typeCondition && sel.typeCondition !== obj.__type) continue;
        Object.assign(out, this.executeSelections(obj, sel.selectionSet, variables, errors));
      } else {
        const alias = sel.alias ?? sel.name;
        out[alias] = this.executeField(obj, sel, variables, errors);
      }
    }
    return out;
  }

  private executeField(
    obj: GqlObject,
    field: FieldNode,
    variables: Record<string, unknown>,
    errors: { message: string }[],
  ): unknown {
    const typeName = obj.__type;
    if (field.name === '__typename') return typeName;
    const allowed = FIELDS[typeName];
    if (!allowed || !allowed.has(field.name)) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return null;
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(field.args)) args[k] = resolveValue(v, variables);
    const value = this.resolveField(obj, field.name, args, variables, errors);
    if (value === null || value === undefined) return null;
    if (!field.selectionSet) return value;
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (item && typeof item === 'object' && '__type' in (item as Record<string, unknown>)) {
          return this.executeSelections(item as GqlObject, field.selectionSet!, variables, errors);
        }
        return item;
      });
    }
    if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
      return this.executeSelections(value as GqlObject, field.selectionSet, variables, errors);
    }
    return value;
  }

  private resolveField(
    obj: GqlObject,
    name: string,
    args: Record<string, unknown>,
    variables: Record<string, unknown>,
    errors: { message: string }[],
  ): unknown {
    const forge = this.forge;
    switch (obj.__type) {
      case 'Query': {
        if (name === 'viewer') {
          return { __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: 'adaiversen@example.invalid' };
        }
        if (name === 'repository') {
          const repo = forge.getRepo(String(args.name ?? ''));
          if (!repo || String(args.owner ?? '') !== repo.owner) return null;
          return repoObject(forge, repo);
        }
        if (name === 'node') {
          const resolved = forge.resolveGlobalId(String(args.id ?? ''));
          if (!resolved) return null;
          if (resolved.kind === 'Repository' && resolved.repo) return repoObject(forge, resolved.repo);
          if (resolved.kind === 'Issue' && resolved.repo && resolved.issue) return issueObject(forge, resolved.repo, resolved.issue);
          if (resolved.kind === 'PullRequest' && resolved.repo && resolved.pull) return pullObject(forge, resolved.repo, resolved.pull);
          if (resolved.kind === 'IssueComment' && resolved.repo && resolved.issue && resolved.comment) {
            return commentObject(forge, resolved.repo, resolved.issue, resolved.comment);
          }
          return null;
        }
        if (name === '__type') {
          const tname = String(args.name ?? '');
          if (!TYPE_FIELDS[tname] && !isEnumType(tname)) return null;
          return {
            __type: '__Type',
            name: tname,
            kind: isEnumType(tname) ? 'ENUM' : 'OBJECT',
            fields: TYPE_FIELDS[tname] ? TYPE_FIELDS[tname].map((n) => ({ __type: '__Field', name: n })) : null,
            enumValues: isEnumType(tname) ? ENUM_VALUES[tname].map((n) => ({ __type: '__EnumValue', name: n })) : null,
          };
        }
        if (name === '__schema') {
          return { __type: '__Schema', queryType: { __type: '__Type', name: 'Query' } };
        }
        return null;
      }
      case 'Repository': {
        const repo = obj.__repo as Repo;
        if (name === 'id') return forge.globalId('Repository', repo.id);
        if (name === 'databaseId') return repo.id;
        if (name === 'name') return repo.name;
        if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
        if (name === 'owner') return { __type: 'User', login: repo.owner, id: VIEWER_ID };
        if (name === 'description') return repo.description;
        if (name === 'private') return repo.private;
        if (name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}`;
        if (name === 'createdAt' || name === 'updatedAt') return new Date((1735689600 + repo.createdSeq) * 1000).toISOString();
        if (name === 'defaultBranchRef') {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (!tip) return null;
          return { __type: 'Ref', name: repo.defaultBranch };
        }
        if (name === 'viewerPermission') return 'ADMIN';
        if (name === 'hasIssuesEnabled') return true;
        if (name === 'issue') {
          const issue = forge.getIssue(repo, Number(args.number));
          return issue ? issueObject(forge, repo, issue) : null;
        }
        if (name === 'issues') {
          return issuesConnection(forge, repo, args);
        }
        if (name === 'pullRequests') {
          const first = typeof args.first === 'number' ? args.first : 100;
          const pulls = forge.listPulls(repo, 'all').sort((a, b) => a.createdSeq - b.createdSeq).slice(0, first);
          return {
            __type: 'PullRequestConnection',
            nodes: pulls.map((p) => pullObject(forge, repo, p)),
            pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null },
            totalCount: forge.listPulls(repo, 'all').length,
          };
        }
        if (name === 'pullRequest') {
          const pull = forge.getPull(repo, Number(args.number));
          return pull ? pullObject(forge, repo, pull) : null;
        }
        return null;
      }
      case 'Issue': {
        const issue = obj.__issue as Issue;
        const repo = obj.__repo as Repo;
        if (name === 'id') return forge.globalId('Issue', repo.id, issue.number);
        if (name === 'number') return issue.number;
        if (name === 'title') return issue.title;
        if (name === 'body') return issue.body;
        if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        if (name === 'author') return { __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
        if (name === 'createdAt') return new Date((1735689600 + issue.createdSeq) * 1000).toISOString();
        if (name === 'updatedAt') return new Date((1735689600 + issue.updatedSeq) * 1000).toISOString();
        if (name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        if (name === 'comments') return issue.comments.length;
        if (name === 'labels') return issue.labels.map((l) => ({ __type: 'Label', name: l.name, color: l.color }));
        return null;
      }
      case 'PullRequest': {
        const pull = obj.__pull as Pull;
        const repo = obj.__repo as Repo;
        if (name === 'id') return forge.globalId('PullRequest', repo.id, pull.number);
        if (name === 'number') return pull.number;
        if (name === 'title') return pull.title;
        if (name === 'body') return pull.body;
        if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        if (name === 'merged') return pull.merged;
        if (name === 'mergeable') return forge.mergeable(repo, pull);
        if (name === 'headRefName') return pull.headRef;
        if (name === 'baseRefName') return pull.baseRef;
        if (name === 'headRef') return { __type: 'Ref', name: pull.headRef };
        if (name === 'baseRef') return { __type: 'Ref', name: pull.baseRef };
        if (name === 'author') return { __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
        if (name === 'createdAt') return new Date((1735689600 + pull.createdSeq) * 1000).toISOString();
        if (name === 'updatedAt') return new Date((1735689600 + pull.updatedSeq) * 1000).toISOString();
        if (name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
        if (name === 'files') {
          const first = typeof args.first === 'number' ? args.first : 100;
          const res = forge.pullFiles(repo, pull.number);
          const files = res.ok ? res.value! : [];
          return {
            __type: 'PullRequestChangedFileConnection',
            nodes: files.slice(0, first).map((f) => ({
              __type: 'PullRequestChangedFile',
              path: f.filename,
              additions: f.additions,
              deletions: f.deletions,
              changes: f.changes,
            })),
            pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null },
            totalCount: files.length,
          };
        }
        return null;
      }
      case 'User': {
        if (name === 'login') return obj.login;
        if (name === 'id') return obj.id ?? VIEWER_ID;
        if (name === 'name') return obj.name ?? 'ada iversen';
        if (name === 'email') return obj.email ?? 'adaiversen@example.invalid';
        if (name === 'url') return `https://example.invalid/${obj.login}`;
        return null;
      }
      case 'Ref': {
        if (name === 'name') return obj.name;
        return null;
      }
      case '__Type': {
        if (name === 'name') return obj.name;
        if (name === 'kind') return obj.kind;
        if (name === 'description') return null;
        if (name === 'fields') return obj.fields ?? null;
        if (name === 'enumValues') return obj.enumValues ?? null;
        return null;
      }
      case '__Field': {
        if (name === 'name') return obj.name;
        if (name === 'description') return null;
        if (name === 'type') return { __type: '__Type', name: 'String' };
        if (name === 'args') return [];
        return null;
      }
      case '__EnumValue': {
        if (name === 'name') return obj.name;
        if (name === 'description') return null;
        return null;
      }
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestChangedFileConnection': {
        if (name === 'nodes') return obj.nodes;
        if (name === 'pageInfo') return obj.pageInfo;
        if (name === 'totalCount') return obj.totalCount;
        return null;
      }
      case 'PageInfo': {
        if (name === 'hasNextPage') return obj.hasNextPage;
        if (name === 'hasPreviousPage') return obj.hasPreviousPage;
        if (name === 'endCursor') return obj.endCursor;
        if (name === 'startCursor') return obj.startCursor;
        return null;
      }
      case 'PullRequestChangedFile': {
        if (name === 'path') return obj.path;
        if (name === 'additions') return obj.additions;
        if (name === 'deletions') return obj.deletions;
        if (name === 'changes') return obj.changes;
        return null;
      }
      case 'IssueComment': {
        if (name === 'id') return obj.__globalId;
        if (name === 'body') return obj.body;
        if (name === 'author') return { __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
        if (name === 'createdAt') return new Date((1735689600 + (obj.__createdSeq as number)) * 1000).toISOString();
        return null;
      }
      case 'IssueCommentEdge': {
        if (name === 'node') return obj.node;
        if (name === 'cursor') return obj.cursor ?? null;
        return null;
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        if (name === 'issue') return obj.issue ?? null;
        return null;
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        if (name === 'pullRequest') return obj.pullRequest ?? null;
        return null;
      }
      case 'AddIssueCommentPayload': {
        if (name === 'commentEdge') return obj.commentEdge ?? null;
        return null;
      }
      default:
        return null;
    }
  }
}

function repoObject(forge: Forge, repo: Repo): GqlObject {
  return { __type: 'Repository', __repo: repo };
}

function issueObject(forge: Forge, repo: Repo, issue: Issue): GqlObject {
  return { __type: 'Issue', __repo: repo, __issue: issue };
}

function pullObject(forge: Forge, repo: Repo, pull: Pull): GqlObject {
  return { __type: 'PullRequest', __repo: repo, __pull: pull };
}

function commentObject(forge: Forge, repo: Repo, issue: Issue, comment: { id: number; body: string; createdSeq: number }): GqlObject {
  return {
    __type: 'IssueComment',
    __globalId: forge.globalId('IssueComment', repo.id, issue.number, comment.id),
    body: comment.body,
    __createdSeq: comment.createdSeq,
  };
}

function issuesConnection(forge: Forge, repo: Repo, args: Record<string, unknown>): GqlObject {
  let list = forge.listIssues(repo, { state: 'all', sort: 'created', direction: 'asc' });
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase() === 'OPEN' ? 'open' : 'closed'));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy) {
    const field = String(orderBy.field ?? 'CREATED_AT');
    const dir = String(orderBy.direction ?? 'ASC') === 'DESC' ? -1 : 1;
    list = [...list].sort((a, b) => {
      const av = field === 'UPDATED_AT' ? a.updatedSeq : field === 'COMMENTS' ? a.comments.length : a.createdSeq;
      const bv = field === 'UPDATED_AT' ? b.updatedSeq : field === 'COMMENTS' ? b.comments.length : b.createdSeq;
      return (av - bv) * dir;
    });
  }
  // Cursor pagination.
  let start = 0;
  const after = args.after as string | undefined;
  if (typeof after === 'string' && after) {
    try {
      const text = Buffer.from(after, 'base64').toString('utf8');
      const m = text.match(/^c:(\d+)$/);
      if (m) start = Number(m[1]) + 1;
    } catch {
      // ignore malformed cursor
    }
  }
  const first = typeof args.first === 'number' ? args.first : 100;
  const page = list.slice(start, start + first);
  const endIndex = start + page.length - 1;
  const hasNextPage = endIndex < list.length - 1;
  const endCursor = page.length > 0 ? Buffer.from(`c:${endIndex}`, 'utf8').toString('base64') : null;
  return {
    __type: 'IssueConnection',
    nodes: page.map((i) => issueObject(forge, repo, i)),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      endCursor,
      startCursor: page.length > 0 ? Buffer.from(`c:${start}`, 'utf8').toString('base64') : null,
    },
    totalCount: list.length,
  };
}

// -------------------------------------------------------------- mutations

export function executeMutation(
  forge: Forge,
  executor: GraphQLExecutor,
  op: Operation,
  variables: Record<string, unknown>,
): GqlResponse {
  const errors: { message: string }[] = [];
  const data: Record<string, unknown> = {};
  for (const sel of op.selectionSet) {
    if (sel.kind === 'inlineFragment') continue;
    const alias = sel.alias ?? sel.name;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, variables);
    const input = (args.input ?? {}) as Record<string, unknown>;
    let payload: GqlObject | null = null;
    if (sel.name === 'createIssue') {
      const resolved = forge.resolveGlobalId(String(input.repositoryId ?? ''));
      if (!resolved || resolved.kind !== 'Repository' || !resolved.repo) {
        errors.push({ message: 'createIssue: repository not found' });
        data[alias] = null;
        continue;
      }
      const res = forge.createIssue(resolved.repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if (!res.ok) {
        errors.push({ message: `createIssue: ${res.message}` });
        data[alias] = null;
        continue;
      }
      payload = { __type: 'CreateIssuePayload', issue: issueObject(forge, resolved.repo, res.value!) };
    } else if (sel.name === 'closeIssue') {
      const resolved = forge.resolveGlobalId(String(input.issueId ?? ''));
      if (!resolved || resolved.kind !== 'Issue' || !resolved.repo || !resolved.issue) {
        errors.push({ message: 'closeIssue: issue not found' });
        data[alias] = null;
        continue;
      }
      const res = forge.patchIssue(resolved.repo, resolved.issue.number, { state: 'closed' });
      if (!res.ok) {
        errors.push({ message: `closeIssue: ${res.message}` });
        data[alias] = null;
        continue;
      }
      payload = { __type: 'CloseIssuePayload', issue: issueObject(forge, resolved.repo, res.value!) };
    } else if (sel.name === 'createPullRequest') {
      const resolved = forge.resolveGlobalId(String(input.repositoryId ?? ''));
      if (!resolved || resolved.kind !== 'Repository' || !resolved.repo) {
        errors.push({ message: 'createPullRequest: repository not found' });
        data[alias] = null;
        continue;
      }
      const res = forge.createPull(
        resolved.repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if (!res.ok) {
        errors.push({ message: `createPullRequest: ${res.message}` });
        data[alias] = null;
        continue;
      }
      payload = { __type: 'CreatePullRequestPayload', pullRequest: pullObject(forge, resolved.repo, res.value!) };
    } else if (sel.name === 'mergePullRequest') {
      const resolved = forge.resolveGlobalId(String(input.pullRequestId ?? ''));
      if (!resolved || resolved.kind !== 'PullRequest' || !resolved.repo || !resolved.pull) {
        errors.push({ message: 'mergePullRequest: pull request not found' });
        data[alias] = null;
        continue;
      }
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      const res = forge.mergePull(resolved.repo, resolved.pull.number, method.toLowerCase());
      if (!res.ok) {
        errors.push({ message: `mergePullRequest: ${res.message}` });
        data[alias] = null;
        continue;
      }
      payload = { __type: 'MergePullRequestPayload', pullRequest: pullObject(forge, resolved.repo, resolved.pull) };
    } else if (sel.name === 'addComment') {
      const resolved = forge.resolveGlobalId(String(input.subjectId ?? ''));
      if (!resolved || resolved.kind !== 'Issue' || !resolved.repo || !resolved.issue) {
        errors.push({ message: 'addComment: subject not found' });
        data[alias] = null;
        continue;
      }
      const res = forge.createComment(resolved.repo, resolved.issue.number, String(input.body ?? ''));
      if (!res.ok) {
        errors.push({ message: `addComment: ${res.message}` });
        data[alias] = null;
        continue;
      }
      payload = {
        __type: 'AddIssueCommentPayload',
        commentEdge: {
          __type: 'IssueCommentEdge',
          node: commentObject(forge, resolved.repo, resolved.issue, res.value!),
          cursor: null,
        },
      };
    } else {
      errors.push({ message: `Cannot query field "${sel.name}" on type "Mutation".` });
      data[alias] = null;
      continue;
    }
    if (sel.selectionSet && payload) {
      data[alias] = executor.executeSelections(payload, sel.selectionSet, variables, errors);
    } else {
      data[alias] = payload;
    }
  }
  const out: GqlResponse = { data };
  if (errors.length > 0) out.errors = errors;
  return out;
}

export function parseGraphQLDocument(query: string): Operation[] {
  return new Parser(tokenize(query)).parseDocument();
}
