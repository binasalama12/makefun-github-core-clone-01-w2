// githttp.ts — git smart HTTP: ref advertisement, upload-pack (protocol
// v2 with ls-refs and fetch, plus a v0 fallback) and receive-pack (v0).
// Everything is served from the repository's own GitStore; no git binary
// is ever invoked.

import {
  GitStore,
  ZERO_OID,
  hashObject,
  parseAllPackets,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  PKT_FLUSH,
  readPack,
  writePack,
  type GitObject,
} from './gitstore.ts';
import type { RepoRec } from './store.ts';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';

function sortedRefs(git: GitStore): Array<[string, string]> {
  return [...git.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The v0 ref advertisement body shared by both services. */
function v0Advertisement(git: GitStore, service: string, capabilities: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines: Buffer[] = [];
  const refs = sortedRefs(git);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    let first = true;
    const headTip = git.tipOf(git.headRef());
    if (headTip) {
      lines.push(pktLine(`${headTip} HEAD\0${capabilities}\n`));
      first = false;
    }
    for (const [ref, oid] of refs) {
      lines.push(pktLine(first ? `${oid} ${ref}\0${capabilities}\n` : `${oid} ${ref}\n`));
      first = false;
      const peeled = git.peel(oid);
      if (peeled !== oid) lines.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  return Buffer.concat([...parts, ...lines, PKT_FLUSH]);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn peel symrefs\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

export function infoRefs(git: GitStore, service: string, gitProtocol: string): GitHttpResult {
  const isV2 = service === 'git-upload-pack' && /(^|[\s,])version=2/.test(gitProtocol);
  if (isV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  const capabilities =
    service === 'git-receive-pack'
      ? `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`
      : `side-band-64k thin-pack ofs-delta shallow no-progress symref=HEAD:refs/heads/${git.defaultBranch} agent=${AGENT}`;
  const honest = capabilities;
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(git, service, honest),
  };
}

// ---------------------------------------------------------------- ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(git: GitStore, args: LsRefsArgs): Buffer {
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = git.headRef();
  const headTip = git.tipOf(headRef);
  if (keep('HEAD')) {
    if (headTip) {
      lines.push(`${headTip} HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`);
    } else {
      lines.push(`${ZERO_OID} HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`);
    }
  }
  for (const [ref, oid] of sortedRefs(git)) {
    if (!keep(ref)) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const peeled = git.peel(oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

function planFetch(git: GitStore, args: FetchArgs): FetchPlan {
  const clientShallow = new Set(args.shallow);
  // Objects the client already holds: the closure of its haves, stopping
  // at the shallow boundary commits it told us about.
  const excluded = new Set<string>();
  {
    const stack = [...args.haves];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (excluded.has(oid)) continue;
      const object = git.get(oid);
      if (!object) continue;
      excluded.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        stack.push(view.tree);
        if (clientShallow.has(oid)) continue; // its parents are not held
        for (const parent of view.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(tagTarget(object.data));
      }
    }
  }

  const included = new Map<string, GitObject>();
  const commitDepth = new Map<string, number>();
  const shallow = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = args.wants.map((oid) => ({ oid, depth: 0 }));
  const seenDepth = new Map<string, number>();
  while (queue.length) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    const previous = seenDepth.get(oid);
    if (previous !== undefined && previous <= depth) continue;
    seenDepth.set(oid, depth);
    const object = git.get(oid);
    if (!object) continue;
    // Held objects are traversed through (a deepen request needs the
    // ancestors behind a held tip) but never re-sent.
    const held = excluded.has(oid);
    if (object.type === 'commit') {
      if (args.depth !== null && depth >= args.depth) {
        continue; // beyond the shallow horizon: not sent, not entered
      }
      if (!held) {
        included.set(oid, object);
        commitDepth.set(oid, depth);
        const view0 = parseCommit(object.data);
        if (args.depth !== null && depth === args.depth - 1 && view0.parents.length > 0) {
          shallow.add(oid);
        }
      }
      const view = parseCommit(object.data);
      queue.push({ oid: view.tree, depth });
      for (const parent of view.parents) queue.push({ oid: parent, depth: depth + 1 });
    } else if (object.type === 'tree') {
      if (!held) included.set(oid, object);
      for (const entry of parseTree(object.data)) queue.push({ oid: entry.oid, depth });
    } else if (object.type === 'tag') {
      if (!held) included.set(oid, object);
      queue.push({ oid: tagTarget(object.data), depth });
    } else if (!held) {
      included.set(oid, object);
    }
  }

  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const view = git.commitOf(oid);
    if (!view) continue;
    if (view.parents.some((parent) => included.has(parent))) unshallow.push(oid);
  }
  const acks = args.haves.filter((have) => git.get(have) && args.wants.some((want) => have === want || git.isAncestor(have, want)));
  return { objects: [...included.values()], shallow: [...shallow], unshallow, acks };
}

function tagTarget(data: Buffer): string {
  return parseTag(data).object;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32_000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, offset + CHUNK);
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) packets.push(pktLine(Buffer.concat([Buffer.from([1])])));
  return packets;
}

function fetchV2(git: GitStore, args: FetchArgs): Buffer {
  const plan = planFetch(git, args);
  const parts: Buffer[] = [];
  // The acknowledgments section only answers a negotiation: a request
  // with no haves gets no such section, just the packfile sections.
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_FLUSH);
  }
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack(plan.objects);
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(git: GitStore, args: FetchArgs): Buffer {
  const plan = planFetch(git, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.acks.length) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  const pack = writePack(plan.objects);
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function uploadPack(git: GitStore, body: Buffer, gitProtocol: string): GitHttpResult {
  const packets = parseAllPackets(body);
  const dataLines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const isV2 = /(^|[\s,])version=2/.test(gitProtocol) || dataLines.some((line) => line.startsWith('command='));
  if (isV2) {
    // Split the packet stream at the delim packet: capabilities before it,
    // command arguments after it, terminated by the flush.
    const delimIndex = packets.findIndex((p) => p.kind === 'delim');
    const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : packets;
    const argLines = argPackets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
    const commandLine = dataLines.find((line) => line.startsWith('command='));
    const command = commandLine ? commandLine.slice('command='.length).replace(/\n$/, '') : '';
    if (command === 'ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of argLines) {
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(git, args) };
    }
    if (command === 'fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
      for (const line of argLines) {
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
        else if (line === 'done') args.done = true;
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(git, args) };
    }
    return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown command\n') };
  }
  // Protocol v0: want section, flush, negotiation section, flush.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') sections.push([]);
    else if (packet.kind === 'data') sections[sections.length - 1].push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  for (const section of sections) {
    for (const line of section) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
      else if (line === 'done') args.done = true;
    }
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0(git, args) };
}

// ---------------------------------------------------------------- receive-pack

export function receivePack(repo: RepoRec, body: Buffer): GitHttpResult {
  const git = repo.git;
  // Command section: pkt-lines up to the first flush; the pack follows raw.
  let offset = 0;
  const commandLines: string[] = [];
  let capabilities = '';
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line in receive-pack');
    const length = Number.parseInt(header, 16);
    if (length === 0) { offset += 4; break; }
    if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line in receive-pack');
    let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    commandLines.push(line);
    offset += length;
  }
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, git.objects);
      for (const object of objects) git.put(object.type, object.data);
    } catch {
      unpackOk = false;
    }
  }
  interface Command { oldOid: string; newOid: string; ref: string }
  const commands: Command[] = [];
  for (const line of commandLines) {
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : 'error'}\n`];
  for (const command of commands) {
    const current = git.refs.get(command.ref) ?? ZERO_OID;
    let failure: string | null = null;
    if (!unpackOk) {
      failure = 'unpacker error';
    } else if (command.newOid === ZERO_OID) {
      // Delete: allowed whenever the ref is where the client believes.
      if (command.oldOid !== current && current !== ZERO_OID) failure = 'non-fast-forward';
    } else if (!git.get(command.newOid)) {
      failure = 'missing object';
    } else if (current === ZERO_OID) {
      if (command.oldOid !== ZERO_OID) failure = 'non-fast-forward';
    } else if (command.oldOid !== current) {
      failure = 'non-fast-forward';
    } else if (command.newOid !== current && git.commitOf(command.newOid) && git.commitOf(current)) {
      if (!git.isAncestor(current, command.newOid)) failure = 'non-fast-forward';
    }
    if (failure) {
      reportLines.push(`ng ${command.ref} ${failure}\n`);
    } else {
      if (command.newOid === ZERO_OID) git.refs.delete(command.ref);
      else git.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
  }
  const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  let responseBody: Buffer;
  if (useSideband) {
    // The report stream rides inside band-1 packets of an outer stream.
    const packets: Buffer[] = [];
    const CHUNK = 32_000;
    for (let at = 0; at < report.length; at += CHUNK) {
      packets.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(at, at + CHUNK)])));
    }
    packets.push(PKT_FLUSH);
    responseBody = Buffer.concat(packets);
  } else {
    responseBody = report;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

export { hashObject };
export type { RepoRec };
