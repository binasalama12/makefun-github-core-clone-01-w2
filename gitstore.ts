// gitstore.ts — a small, self-contained git object store.
//
// Objects are kept in a Map keyed by their SHA-1 id, computed exactly the
// way git computes it (a "<type> <size>\0" header followed by the raw
// bytes). This module also owns the wire helpers the HTTP layer needs:
// pkt-line framing, packfile reading (plain objects plus OFS/REF deltas)
// and packfile writing (plain objects only — a valid, if uncompressed-by-
// delta, pack is all a conforming client requires).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_TO_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(left, right);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export function buildCommit(input: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  const out = { object: '', type: '', tag: '' };
  for (const line of text.slice(0, text.indexOf('\n\n') < 0 ? text.length : text.indexOf('\n\n')).split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
  }
  return out;
}

/** Apply a git binary delta (the format used by OFS_DELTA / REF_DELTA). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { copyOffset |= delta[offset] << (8 * i); offset += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { copySize |= delta[offset] << (8 * i); offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface ParsedPackets {
  /** Data packet payloads, in order, up to the first flush. */
  payloads: Buffer[];
  /** Byte offset just past that terminating flush (or the buffer end). */
  rest: number;
}

/** Parse pkt-lines until the first flush packet; tolerant of a clean EOF. */
export function parsePacketsUntilFlush(buffer: Buffer): ParsedPackets {
  const payloads: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line header');
    const length = Number.parseInt(header, 16);
    if (length === 0) return { payloads, rest: offset + 4 };
    if (length === 1 || length === 2) { offset += 4; continue; }
    if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line');
    payloads.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  if (offset !== buffer.length) throw new Error('trailing bytes after pkt-lines');
  return { payloads, rest: offset };
}

/** Parse a whole pkt-line buffer into payloads and control markers. */
export function parseAllPackets(buffer: Buffer): Array<{ kind: string; payload: Buffer }> {
  const out: Array<{ kind: string; payload: Buffer }> = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line header');
    const length = Number.parseInt(header, 16);
    if (length === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (length === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (length === 2) { out.push({ kind: 'end', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset !== buffer.length) throw new Error('trailing bytes after pkt-lines');
  return out;
}

// ---------------------------------------------------------------- packfiles

/** Serialize objects as a version-2 packfile with a SHA-1 trailer. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = TYPE_TO_CODE[object.type];
    let size = object.data.length;
    const first = size & 0x0f;
    size >>= 4;
    const bytes: number[] = [];
    let byte = (code << 4) | first;
    while (size > 0) {
      bytes.push(byte | 0x80);
      byte = size & 0x7f;
      size >>= 7;
    }
    bytes.push(byte);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Read a packfile into objects, resolving delta chains as needed. */
export function readPack(pack: Buffer, externalBases?: Map<string, GitObject>): GitObject[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('packfile checksum mismatch');
  interface RawEntry { type: GitObjectType; data: Buffer; baseOffset?: number; baseOid?: string; start: number }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (code === 6) { // OFS_DELTA
      byte = pack[offset];
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - back;
    } else if (code === 7) { // REF_DELTA
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const type = CODE_TO_TYPE[code];
    // Inflate exactly one stream: inflateSync stops at the stream end when
    // given the remaining bytes only if we find the consumed length by
    // trying progressively is wasteful, so rely on zlib's streaming API
    // through a bounded probe: deflate streams are self-terminating and
    // inflateSync on a subarray that extends past the end throws for some
    // builds — the safe path is the incremental approach below.
    const inflated = inflateOne(pack, offset);
    offset += inflated.consumed;
    if (inflated.data.length !== size && type !== undefined) {
      // Deltas describe the *result* size in their header; keep the bytes.
    }
    byOffset.set(start, raw.length);
    raw.push({ type: type as GitObjectType, data: inflated.data, baseOffset, baseOid, start });
  }
  const external = externalBases ?? new Map<string, GitObject>();
  const resolved: Array<GitObject | null> = raw.map(() => null);
  const resolve = (index: number): GitObject => {
    const cached = resolved[index];
    if (cached) return cached;
    const entry = raw[index];
    let object: GitObject;
    if (entry.baseOffset === undefined && entry.baseOid === undefined) {
      object = { type: entry.type, data: entry.data };
    } else {
      let base: GitObject;
      if (entry.baseOffset !== undefined) {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
        base = resolve(baseIndex);
      } else {
        const found = external.get(entry.baseOid as string);
        if (!found) throw new Error('ref-delta base not supplied');
        base = found;
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolved[index] = object;
    return object;
  };
  const out: GitObject[] = [];
  for (let i = 0; i < raw.length; i += 1) out.push(resolve(i));
  return out;
}

/** Inflate one zlib stream starting at `offset`, reporting bytes consumed. */
function inflateOne(buffer: Buffer, offset: number): { data: Buffer; consumed: number } {
  // zlib ignores bytes after a stream's end, and a truncated stream throws,
  // so "the prefix inflates to the same bytes" is monotone in its length:
  // binary-search the shortest such prefix; that is the stream's length.
  const whole = inflateSync(buffer.subarray(offset));
  let lo = offset + 1;
  let hi = buffer.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      ok = inflateSync(buffer.subarray(offset, mid)).equals(whole);
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return { data: whole, consumed: lo - offset };
}

// ---------------------------------------------------------------- the store

/** One repository's objects and refs, plus the graph walks the forge needs. */
export class GitStore {
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  defaultBranch = 'main';

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  tipOf(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  /** Peel a tag (possibly nested) down to the object it ultimately names. */
  peel(oid: string): string {
    let current = oid;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  commitOf(oid: string): CommitView | null {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** Every object reachable from `roots`; `stopAt` commits are not entered. */
  reachable(roots: string[], stopAt?: Set<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (seen.has(oid) || (stopAt && stopAt.has(oid))) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        stack.push(view.tree);
        for (const parent of view.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** Ancestor commits of `oid`, including itself, in breadth-first order. */
  ancestorsOf(oid: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const queue = [oid];
    while (queue.length) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      const view = this.commitOf(current);
      if (!view) continue;
      seen.add(current);
      order.push(current);
      for (const parent of view.parents) queue.push(parent);
    }
    return order;
  }

  isAncestor(maybeAncestor: string, oid: string): boolean {
    return this.ancestorsOf(oid).includes(maybeAncestor);
  }

  /** A best common ancestor of two commits, or null when there is none. */
  mergeBase(a: string, b: string): string | null {
    const ofB = new Set(this.ancestorsOf(b));
    for (const candidate of this.ancestorsOf(a)) if (ofB.has(candidate)) return candidate;
    return null;
  }

  /** Flatten a commit's tree into a path -> {oid, mode} map. */
  filesOf(commitOid: string): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    const view = this.commitOf(commitOid);
    if (!view) return files;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = this.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
        else files.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(view.tree, '');
    return files;
  }

  /** Build (and store) a tree from a flat path -> blob map. */
  treeFromFiles(files: Map<string, { oid: string; mode: string }>): string {
    interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, info] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], make());
        node = node.dirs.get(segments[i]) as Node;
      }
      node.files.set(segments[segments.length - 1], info);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, info] of node.files) entries.push({ mode: info.mode, name, oid: info.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit over the given file map and return its id. */
  commitFiles(input: {
    files: Map<string, { oid: string; mode: string }>;
    parents: string[];
    author: string;
    message: string;
  }): string {
    const tree = this.treeFromFiles(input.files);
    const data = buildCommit({
      tree,
      parents: input.parents,
      author: input.author,
      committer: input.author,
      message: input.message,
    });
    return this.put('commit', data);
  }
}
