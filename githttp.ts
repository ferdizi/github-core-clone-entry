// githttp.ts — git smart HTTP: info/refs (v0/v2), upload-pack (v2/v0),
// receive-pack (v0). Operates on a Forge store.
import {
  pktLine,
  encodePktLines,
  decodePktLines,
  writePack,
  readPack,
  putObject,
  getObject,
  parseCommit,
  parseTree,
  collectFetch,
  isAncestor,
  isSha40,
  ZERO_OID,
} from './gitproto.ts';
import { Forge, VIEWER_LOGIN } from './store.ts';
import type { Repo } from './store.ts';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

// Small cache for deterministic git responses (advertisements, ls-refs,
// fetches). Keys embed the repo's version counter, which is bumped on every
// mutation to objects or refs, so a cached body is only reused while the
// store it was built from is unchanged.
const responseCache = new Map<string, Buffer>();
function cacheGet(key: string): Buffer | undefined {
  return responseCache.get(key);
}
function cacheSet(key: string, value: Buffer): void {
  if (responseCache.size > 500) responseCache.clear();
  responseCache.set(key, value);
}

function jsonResult(status: number, obj: unknown): HttpResult {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify(obj), 'utf8') };
}

function resolveRepo(forge: Forge, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(name) ?? null;
}

/** All refs sorted: HEAD first (when it resolves), then heads, then tags. */
export function listRefs(repo: Repo): { name: string; oid: string; peeled?: string }[] {
  const out: { name: string; oid: string; peeled?: string }[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip) out.push({ name: 'HEAD', oid: defaultTip });
  const heads: string[] = [];
  const tags: string[] = [];
  for (const ref of [...repo.refs.keys()].sort()) {
    if (ref.startsWith('refs/heads/')) heads.push(ref);
    else if (ref.startsWith('refs/tags/')) tags.push(ref);
  }
  for (const ref of heads) out.push({ name: ref, oid: repo.refs.get(ref)! });
  for (const ref of tags) {
    const oid = repo.refs.get(ref)!;
    const peeled = forge_peel(repo, oid);
    out.push({ name: ref, oid, peeled: peeled ?? undefined });
  }
  return out;
}

function forge_peel(repo: Repo, oid: string): string | null {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'tag') return null;
  const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
  return m ? m[1] : null;
}

const UPLOAD_CAPS = 'side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

function v0Advertisement(service: string, refs: { name: string; oid: string; peeled?: string }[], caps: string): Buffer {
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const first = refs[0];
    lines.push(pktLine(`${first.oid} ${first.name}\0${caps}\n`));
    for (let i = 1; i < refs.length; i++) {
      lines.push(pktLine(`${refs[i].oid} ${refs[i].name}\n`));
      if (refs[i].peeled) lines.push(pktLine(`${refs[i].peeled} ${refs[i].name}^{}\n`));
    }
    if (refs[0].peeled) lines.push(pktLine(`${refs[0].peeled} ${refs[0].name}^{}\n`));
  }
  lines.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(lines);
}

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string | undefined,
  gitProtocol: string | undefined,
): HttpResult {
  const repo = resolveRepo(forge, owner, repoName);
  if (!repo) return jsonResult(404, { message: 'Not Found' });
  if (service === 'git-upload-pack') {
    const refs = listRefs(repo);
    const cacheKey = `info:${repo.id}:${repo.version}:${service}:${gitProtocol ?? ''}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: cached };
    }
    if (gitProtocol === 'version=2') {
      const body = encodePktLines([
        'version 2\n',
        'agent=forge/1.0\n',
        'ls-refs=unborn\n',
        'fetch=shallow filter\n',
        'object-format=sha1\n',
      ]);
      const out = Buffer.concat([body, Buffer.from('0000', 'ascii')]);
      cacheSet(cacheKey, out);
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: out };
    }
    const out = v0Advertisement('git-upload-pack', refs, UPLOAD_CAPS);
    cacheSet(cacheKey, out);
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: out,
    };
  }
  if (service === 'git-receive-pack') {
    const cacheKey = `info:${repo.id}:${repo.version}:${service}:`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: cached };
    }
    const refs = listRefs(repo);
    const out = v0Advertisement('git-receive-pack', refs, RECEIVE_CAPS);
    cacheSet(cacheKey, out);
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-advertisement',
      body: out,
    };
  }
  return jsonResult(400, { message: 'unknown service' });
}

// ------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const cacheKey = `ls:${repo.id}:${repo.version}:${args.peel}:${args.symrefs}:${args.unborn}:${args.prefixes.join(',')}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const refs = listRefs(repo);
  const lines: string[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (args.prefixes.length === 0) {
    if (defaultTip) {
      lines.push(`${defaultTip} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  }
  for (const ref of refs) {
    if (ref.name === 'HEAD') continue;
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(line + '\n');
  }
  const out = Buffer.concat([encodePktLines(lines), Buffer.from('0000', 'ascii')]);
  cacheSet(cacheKey, out);
  return out;
}

// --------------------------------------------------------------- fetch (v2)

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(i + CHUNK, pack.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

function fetchResponse(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  oldShallow: string[],
): Buffer {
  const { packObjects, shallowOut, unshallowOut } = collectFetch(repo, wants, haves, depth, oldShallow);
  const pack = writePack(repo, packObjects);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  const common = haves.filter((h) => {
    const obj = getObject(repo, h);
    if (!obj) return false;
    // ACK haves that are ancestors of a want.
    return wants.some((w) => isAncestor(repo, h, w));
  });
  if (common.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  // shallow-info
  if (depth !== undefined || oldShallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0000', 'ascii'));
  }
  // packfile
  parts.push(pktLine('packfile\n'));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function fetchV0Response(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  oldShallow: string[],
): Buffer {
  const { packObjects, shallowOut, unshallowOut } = collectFetch(repo, wants, haves, depth, oldShallow);
  const pack = writePack(repo, packObjects);
  const parts: Buffer[] = [];
  const common = haves.filter((h) => {
    const obj = getObject(repo, h);
    if (!obj) return false;
    return wants.some((w) => isAncestor(repo, h, w));
  });
  if (common.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
  }
  for (const oid of shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export function handleUploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  gitProtocol: string | undefined,
  body: Buffer,
): HttpResult {
  const repo = resolveRepo(forge, owner, repoName);
  if (!repo) return jsonResult(404, { message: 'Not Found' });
  let packets;
  try {
    packets = decodePktLines(body).packets;
  } catch (e) {
    return jsonResult(400, { message: `malformed request: ${(e as Error).message}` });
  }
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload!.toString('utf8'));
  const CT = 'application/x-git-upload-pack-result';
  if (gitProtocol === 'version=2') {
    // v2: command line, agent/object-format lines, delim, args, flush.
    const commandLine = lines[0] ?? '';
    const m = commandLine.match(/^command=([a-z-]+)/);
    if (!m) return jsonResult(400, { message: 'missing command' });
    const args = lines.slice(1);
    if (m[1] === 'ls-refs') {
      const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const a of args) {
        const line = a.trim();
        if (line === 'peel') lsArgs.peel = true;
        else if (line === 'symrefs') lsArgs.symrefs = true;
        else if (line === 'unborn') lsArgs.unborn = true;
        else if (line.startsWith('ref-prefix ')) lsArgs.prefixes.push(line.slice('ref-prefix '.length));
      }
      return { status: 200, contentType: CT, body: handleLsRefs(repo, lsArgs) };
    }
    if (m[1] === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | undefined;
      for (const a of args) {
        const line = a.trim();
        if (line.startsWith('want ')) wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) {
          const n = Number(line.slice(7).trim());
          if (Number.isFinite(n) && n > 0) depth = n;
        }
      }
      const fetchKey = `fetch2:${repo.id}:${repo.version}:${wants.join(',')}:${haves.join(',')}:${depth ?? ''}:${shallow.join(',')}`;
      const cachedFetch = cacheGet(fetchKey);
      if (cachedFetch) return { status: 200, contentType: CT, body: cachedFetch };
      const out = fetchResponse(repo, wants, haves, depth, shallow);
      cacheSet(fetchKey, out);
      return { status: 200, contentType: CT, body: out };
    }
    return jsonResult(400, { message: `unknown command ${m[1]}` });
  }
  // v0: want/have/shallow/deepen lines in either section.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isSha40(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isSha40(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const fetchKey = `fetch0:${repo.id}:${repo.version}:${wants.join(',')}:${haves.join(',')}:${depth ?? ''}:${shallow.join(',')}`;
  const cachedFetch = cacheGet(fetchKey);
  if (cachedFetch) return { status: 200, contentType: CT, body: cachedFetch };
  const out = fetchV0Response(repo, wants, haves, depth, shallow);
  cacheSet(fetchKey, out);
  return { status: 200, contentType: CT, body: out };
}

// ----------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
): HttpResult {
  const repo = resolveRepo(forge, owner, repoName);
  if (!repo) return jsonResult(404, { message: 'Not Found' });
  // Split: pkt-lines until the first flush; the remainder is the pack.
  let flushEnd = -1;
  let pos = 0;
  const commandLines: string[] = [];
  try {
    while (pos < body.length) {
      const hex = body.toString('ascii', pos, pos + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('invalid pkt-line length');
      const len = parseInt(hex, 16);
      if (len === 0) {
        flushEnd = pos + 4;
        break;
      }
      if (len < 4 || pos + len > body.length) throw new Error('bad pkt-line length');
      const payload = body.toString('utf8', pos + 4, pos + len);
      commandLines.push(payload);
      pos += len;
    }
  } catch (e) {
    return jsonResult(400, { message: `malformed request: ${(e as Error).message}` });
  }
  if (flushEnd === -1) return jsonResult(400, { message: 'malformed request: no flush' });
  const packBytes = body.subarray(flushEnd);
  const commands: PushCommand[] = [];
  for (const raw of commandLines) {
    const firstPart = raw.split('\0')[0];
    const parts = firstPart.trim().split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const reportLines: string[] = [];
  // Unpack first (objects are stored even when a ref update is refused).
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdates && packBytes.length > 0) {
    try {
      const entries = readPack(repo, packBytes);
      for (const e of entries) putObject(repo, e.type, e.data);
      // Verify every new tip's closure is complete.
      for (const c of commands) {
        if (c.newOid === ZERO_OID) continue;
        const obj = getObject(repo, c.newOid);
        if (!obj) throw new Error(`missing object ${c.newOid}`);
        if (obj.type === 'commit') {
          const check = (oid: string, seen: Set<string>): boolean => {
            if (seen.has(oid)) return true;
            seen.add(oid);
            const o = getObject(repo, oid);
            if (!o) return false;
            if (o.type === 'commit') {
              const ci = parseCommit(o.data);
              if (!getObject(repo, ci.tree)) return false;
              return ci.parents.every((p) => check(p, seen));
            }
            if (o.type === 'tree') {
              return parseTree(o.data).every((e) => e.mode === '160000' || check(e.oid, seen));
            }
            if (o.type === 'tag') {
              const mm = o.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
              return mm ? check(mm[1], seen) : false;
            }
            return true;
          };
          if (!check(c.newOid, new Set())) throw new Error('incomplete object closure');
        }
      }
    } catch (e) {
      unpackOk = false;
      unpackDetail = (e as Error).message;
    }
  }
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (!current) reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        else if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        else {
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
      } else if (cmd.oldOid === ZERO_OID) {
        // create
        if (current) reportLines.push(`ng ${cmd.ref} already exists\n`);
        else {
          repo.refs.set(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
      } else {
        // update
        if (!current) reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        else if (current !== cmd.oldOid) reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        else if (!isAncestor(repo, current, cmd.newOid)) reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        else {
          repo.refs.set(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
      }
    }
  }
  if (commands.length > 0) repo.version++;
  const report = encodePktLines(reportLines);
  const sideband = pktLine(Buffer.concat([Buffer.from([1]), report]));
  const out = Buffer.concat([sideband, Buffer.from('0000', 'ascii')]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: out };
}
