// gitproto.ts — git object model, pkt-line codec, pack read/write,
// reachability, three-way merge. Stdlib only (node:crypto, node:zlib).
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface ObjectStore {
  objects: Map<string, GitObject>;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isSha40(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function putObject(store: ObjectStore, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.objects.has(oid)) store.objects.set(oid, { type, data });
  return oid;
}

export function getObject(store: ObjectStore, oid: string): GitObject | undefined {
  return store.objects.get(oid);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(
  tree: string,
  parents: string[],
  author: string,
  committer: string,
  message: string,
): Buffer {
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${author}\n`;
  out += `committer ${committer}\n`;
  out += '\n';
  out += message.endsWith('\n') ? message : message + '\n';
  return Buffer.from(out, 'utf8');
}

// ------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp);
    if (sp === -1 || nul === -1) throw new Error('corrupt tree object');
    const mode = data.toString('utf8', i, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

function gitEntryKey(e: TreeEntry): string {
  return e.mode === '40000' ? e.name + '/' : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = gitEntryKey(a);
    const kb = gitEntryKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build nested trees from a flat path -> {mode, oid} map. Stores trees. */
export function treeFromFiles(
  store: ObjectStore,
  files: Map<string, { mode: string; oid: string }>,
): string {
  // Build a nested structure: dir path -> Map<name, entry>
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of node.files) entries.push({ mode: f.mode, name, oid: f.oid });
    for (const [name, sub] of node.dirs) {
      const oid = build(sub);
      entries.push({ mode: '40000', name, oid });
    }
    return putObject(store, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Flatten a tree (by oid) to path -> {mode, oid}. Skips gitlinks (160000). */
export function flattenTree(store: ObjectStore, treeOid: string): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = store.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else if (e.mode === '160000') continue; // gitlink: skip
      else out.set(path, { mode: e.mode, oid: e.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

// ------------------------------------------------------------- reachability

/** Peel a tag object to its target commit oid (or the oid itself). */
export function peelToCommit(store: ObjectStore, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i++) {
    const obj = store.objects.get(cur);
    if (!obj) return cur;
    if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (!m) return cur;
      cur = m[1];
    } else {
      return cur;
    }
  }
  return cur;
}

/** Full object closure reachable from the given tips (commits/tags/trees). */
export function reachable(store: ObjectStore, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = store.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree) queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') queue.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) queue.push(m[1]);
    }
  }
  return seen;
}

export function isAncestor(store: ObjectStore, anc: string, desc: string): boolean {
  const a = peelToCommit(store, anc);
  const d = peelToCommit(store, desc);
  if (a === d) return true;
  const seen = new Set<string>();
  const queue: string[] = [d];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === a) return true;
      queue.push(p);
    }
  }
  return false;
}

/** First common ancestor commit of a and b (BFS by generation). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ca = peelToCommit(store, a);
  const cb = peelToCommit(store, b);
  if (ca === cb) return ca;
  const fromA = new Set<string>();
  const qa: string[] = [ca];
  while (qa.length > 0) {
    const oid = qa.shift()!;
    if (fromA.has(oid)) continue;
    fromA.add(oid);
    const obj = store.objects.get(oid);
    if (obj && obj.type === 'commit') qa.push(...parseCommit(obj.data).parents);
  }
  const qb: string[] = [cb];
  const seenB = new Set<string>();
  while (qb.length > 0) {
    const oid = qb.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (fromA.has(oid)) return oid;
    const obj = store.objects.get(oid);
    if (obj && obj.type === 'commit') qb.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** Commit generation (distance from tip) for commits reachable from tips. */
export function commitGenerations(store: ObjectStore, tips: string[]): Map<string, number> {
  const gen = new Map<string, number>();
  const queue: { oid: string; g: number }[] = [];
  for (const t of tips) queue.push({ oid: peelToCommit(store, t), g: 0 });
  while (queue.length > 0) {
    const { oid, g } = queue.shift()!;
    if (gen.has(oid)) continue;
    const obj = store.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    gen.set(oid, g);
    for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, g: g + 1 });
  }
  return gen;
}

/** Tree object + all nested trees/blobs under it. */
export function treeClosure(store: ObjectStore, treeOid: string): Set<string> {
  const out = new Set<string>();
  const walk = (oid: string): void => {
    const obj = store.objects.get(oid);
    if (!obj || obj.type !== 'tree' || out.has(oid)) return;
    out.add(oid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '160000') continue;
      if (e.mode === '40000') walk(e.oid);
      else out.add(e.oid);
    }
  };
  walk(treeOid);
  return out;
}

/** A commit + its tree closure (no parents). */
export function commitObjects(store: ObjectStore, commitOid: string): Set<string> {
  const out = new Set<string>([commitOid]);
  const obj = store.objects.get(commitOid);
  if (obj && obj.type === 'commit') {
    for (const oid of treeClosure(store, parseCommit(obj.data).tree)) out.add(oid);
  }
  return out;
}

/**
 * The set of objects the client already holds, given its `have` oids and its
 * shallow boundaries: closure of haves, but a shallow boundary commit's
 * parents are NOT held (the client never received them).
 */
export function heldClosure(store: ObjectStore, haves: string[], shallowBoundaries: string[]): Set<string> {
  const shallow = new Set(shallowBoundaries);
  const held = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const obj = store.objects.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      for (const t of treeClosure(store, parseCommit(obj.data).tree)) held.add(t);
      if (!shallow.has(oid)) queue.push(...parseCommit(obj.data).parents);
    } else if (obj.type === 'tree') {
      for (const t of treeClosure(store, oid)) held.add(t);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) queue.push(m[1]);
    }
  }
  return held;
}

/** Objects to send for a fetch: wants minus haves, with depth + shallow info. */
export function collectFetch(
  store: ObjectStore,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  oldShallow: string[],
): { packObjects: Set<string>; shallowOut: string[]; unshallowOut: string[] } {
  const held = heldClosure(store, haves, oldShallow);
  const gen = commitGenerations(store, wants);
  const included = new Set<string>();
  for (const [oid, g] of gen) {
    if (depth === undefined || g < depth) included.add(oid);
  }
  // Objects to send: each included commit + its tree closure, plus tag wants.
  const packObjects = new Set<string>();
  for (const oid of included) {
    for (const o of commitObjects(store, oid)) if (!held.has(o)) packObjects.add(o);
  }
  for (const w of wants) {
    const obj = store.objects.get(w);
    if (obj && obj.type === 'tag' && !held.has(w)) packObjects.add(w);
  }
  // New shallow boundaries: included commits with a parent neither included nor held.
  const shallowOut: string[] = [];
  for (const oid of included) {
    const obj = store.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.some((p) => !included.has(p) && !held.has(p))) {
      shallowOut.push(oid);
    }
  }
  // Unshallow: old boundaries whose parents are all included-or-held.
  const unshallowOut: string[] = [];
  const stillShallow = new Set<string>();
  for (const s of oldShallow) {
    const obj = store.objects.get(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.every((p) => included.has(p) || held.has(p))) {
      unshallowOut.push(s);
    } else {
      stillShallow.add(s);
    }
  }
  // Echo still-valid old boundaries as shallow (only when a depth/shallow fetch).
  if (depth !== undefined || oldShallow.length > 0) {
    for (const s of stillShallow) if (!shallowOut.includes(s)) shallowOut.push(s);
  }
  return { packObjects, shallowOut, unshallowOut };
}

// ---------------------------------------------------------- three-way merge

export interface MergeResult {
  conflict: boolean;
  treeOid: string | null;
}

/** Three-way merge of trees (base = merge-base tree). Returns merged tree oid or conflict. */
export function threeWayMerge(
  store: ObjectStore,
  baseTreeOid: string,
  oursTreeOid: string,
  theirsTreeOid: string,
): MergeResult {
  const base = baseTreeOid ? flattenTree(store, baseTreeOid) : new Map();
  const ours = flattenTree(store, oursTreeOid);
  const theirs = flattenTree(store, theirsTreeOid);
  const merged = new Map<string, { mode: string; oid: string }>();
  const allPaths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of allPaths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x: { oid: string } | undefined, y: { oid: string } | undefined): boolean =>
      (!x && !y) || (!!x && !!y && x.oid === y.oid);
    if (same(o, t)) {
      if (o) merged.set(path, o);
      continue;
    }
    if (same(o, b)) {
      if (t) merged.set(path, t);
      continue;
    }
    if (same(t, b)) {
      if (o) merged.set(path, o);
      continue;
    }
    return { conflict: true, treeOid: null };
  }
  return { conflict: false, treeOid: treeFromFiles(store, merged) };
}

export function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const text = buf.toString('utf8');
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

export interface DiffEntry {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export function diffTrees(store: ObjectStore, baseTreeOid: string, headTreeOid: string): DiffEntry[] {
  const base = baseTreeOid ? flattenTree(store, baseTreeOid) : new Map();
  const head = flattenTree(store, headTreeOid);
  const out: DiffEntry[] = [];
  const allPaths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...allPaths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const old = store.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const del = countLines(old);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: del, changes: del });
    } else if (!b && h) {
      const cur = store.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const add = countLines(cur);
      out.push({ filename: path, status: 'added', additions: add, deletions: 0, changes: add });
    } else if (b && h && b.oid !== h.oid) {
      const old = store.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const cur = store.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const add = countLines(cur);
      const del = countLines(old);
      out.push({ filename: path, status: 'modified', additions: add, deletions: del, changes: add + del });
    }
  }
  return out;
}

// -------------------------------------------------------------- pkt-line

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([head, body]);
}

export function encodePktLines(lines: (Buffer | string)[]): Buffer {
  return Buffer.concat(lines.map((l) => pktLine(l)));
}

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer | null;
}

export function decodePktLines(buf: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('pkt-line: truncated length');
    const hex = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('pkt-line: invalid length prefix');
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: null });
      i += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: null });
      i += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', payload: null });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) throw new Error('pkt-line: bad length');
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, rest: buf.subarray(i) };
}

// ------------------------------------------------------------------- packs

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  let first = (code << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  const bytes: number[] = [first];
  while (rest > 0) {
    bytes[bytes.length - 1] |= 0x80;
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
    bytes.push(first);
  }
  return Buffer.from(bytes);
}

export function writePack(store: ObjectStore, oids: Iterable<string>): Buffer {
  const list = [...oids];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const obj = store.objects.get(oid);
    if (!obj) throw new Error(`writePack: missing object ${oid}`);
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const trailer = createHash('sha1').update(Buffer.concat(parts)).digest();
  parts.push(trailer);
  return Buffer.concat(parts);
}

interface RawPackEntry {
  type: ObjType;
  data: Buffer;
  offset: number;
  oid: string;
}

function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = buf[pos] & 0x7f;
  let shift = 7;
  let i = pos + 1;
  while (buf[i - 1] & 0x80) {
    value |= (buf[i] & 0x7f) << shift;
    shift += 7;
    i++;
  }
  return { value, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaSize = (): number => {
    let size = 0;
    let shift = 0;
    while (true) {
      const b = delta[pos++];
      size |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return size;
  };
  const baseSize = readDeltaSize();
  const resultSize = readDeltaSize();
  if (baseSize !== base.length) throw new Error('pack delta: base size mismatch');
  const chunks: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit++) if (op & (1 << bit)) offset |= delta[pos++] << (8 * bit);
      for (let bit = 0; bit < 3; bit++) if (op & (0x10 << bit)) size |= delta[pos++] << (8 * bit);
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('pack delta: zero opcode');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== resultSize || produced !== resultSize) throw new Error('pack delta: result size mismatch');
  return out;
}

/** Parse a pack (version 2/3, plain + OFS/REF deltas), verify trailer, store objects. */
export function readPack(store: ObjectStore, buf: Buffer): RawPackEntry[] {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const computed = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!computed.equals(trailer)) throw new Error('pack checksum mismatch');
  interface EntryMeta {
    offset: number;
    typeCode: number;
    size: number;
    dataStart: number;
    dataEnd: number;
    baseOffset?: number;
    baseOid?: string;
  }
  const metas: EntryMeta[] = [];
  let pos = 12;
  for (let n = 0; n < count; n++) {
    const offset = pos;
    const first = buf[pos];
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let i = pos + 1;
    while (buf[i - 1] & 0x80) {
      size |= (buf[i] & 0x7f) << shift;
      shift += 7;
      i++;
    }
    const meta: EntryMeta = { offset, typeCode, size, dataStart: i, dataEnd: i };
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint
      let byte = buf[i++];
      let off = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[i++];
        off = ((off + 1) << 7) | (byte & 0x7f);
      }
      meta.baseOffset = offset - off;
      meta.dataStart = i;
    } else if (typeCode === 7) {
      meta.baseOid = buf.subarray(i, i + 20).toString('hex');
      meta.dataStart = i + 20;
    }
    // Inflate to find consumed length.
    const view = buf.subarray(meta.dataStart, buf.length - 20);
    const inflated = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const consumed = inflated.engine.bytesWritten;
    meta.dataEnd = meta.dataStart + consumed;
    metas.push(meta);
    pos = meta.dataEnd;
  }
  const byOffset = new Map<number, EntryMeta>();
  for (const m of metas) byOffset.set(m.offset, m);
  const resolved = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const resolve = (meta: EntryMeta, depth: number): { type: ObjType; data: Buffer; oid: string } => {
    if (resolved.has(meta.offset)) return resolved.get(meta.offset)!;
    if (depth > 100) throw new Error('pack delta chain too deep');
    const view = buf.subarray(meta.dataStart, meta.dataEnd);
    const raw = inflateSync(view);
    if (meta.typeCode === 6 || meta.typeCode === 7) {
      let base: { type: ObjType; data: Buffer } | undefined;
      if (meta.typeCode === 6) {
        const baseMeta = byOffset.get(meta.baseOffset!);
        if (!baseMeta) throw new Error('pack ofs-delta: base not in pack');
        base = resolve(baseMeta, depth + 1);
      } else {
        const inPack = metas.find((m) => {
          // find entry whose oid matches baseOid — resolve lazily below
          return false;
        });
        void inPack;
        // REF delta: base may be in this pack (resolve by oid) or in the store.
        let baseEntry: { type: ObjType; data: Buffer } | undefined;
        for (const m of metas) {
          if (m.typeCode === 6 || m.typeCode === 7) continue;
          const cand = resolve(m, depth + 1);
          if (cand.oid === meta.baseOid) {
            baseEntry = cand;
            break;
          }
        }
        if (!baseEntry) {
          const stored = store.objects.get(meta.baseOid!);
          if (stored) baseEntry = stored;
        }
        if (!baseEntry) throw new Error('pack ref-delta: base not found');
        base = baseEntry;
      }
      const data = applyDelta(base.data, raw);
      const out = { type: base.type, data, oid: hashObject(base.type, data) };
      resolved.set(meta.offset, out);
      return out;
    }
    const type = CODE_TYPE[meta.typeCode];
    if (!type) throw new Error(`pack: unknown type code ${meta.typeCode}`);
    if (raw.length !== meta.size) throw new Error('pack: size mismatch');
    const out = { type, data: raw, oid: hashObject(type, raw) };
    resolved.set(meta.offset, out);
    return out;
  };
  const entries: RawPackEntry[] = [];
  for (const m of metas) {
    const r = resolve(m, 0);
    entries.push({ type: r.type, data: r.data, offset: m.offset, oid: r.oid });
  }
  return entries;
}
