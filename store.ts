// store.ts — the forge's domain state: repositories, labels, issues,
// comments and pull requests, held in plain Maps over one GitStore per
// repository. Every surface (REST, GraphQL, MCP, git HTTP) reads and
// writes through this single store, so an object created on one surface
// is the same object on every other.
//
// Identity conventions:
//   - the token owner's login is a fixed, scenario-derived constant;
//   - numeric ids come from one monotone counter, so they never repeat;
//   - GraphQL global ids are base64("<Type>:<numeric id>") — opaque,
//     stable across reads, and decodable by node(id:) alone;
//   - timestamps come from a logical clock that starts at a fixed epoch
//     and advances one second per stamped event, never from the wall
//     clock, so two identical request sequences stamp identically.

import { GitStore, ZERO_OID, parseCommit } from './gitstore.ts';

export const OWNER_LOGIN = 'adaiversen';
export const OWNER_ID = 1000;
export const OWNER_NAME = 'ada iversen';
export const OWNER_EMAIL = 'adaiversen@example.invalid';

const EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

export interface IssueRec {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** The base branch tip captured when the pull was opened. */
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RepoRec {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  git: GitStore;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

export function globalId(type: string, numericId: number): string {
  return Buffer.from(`${type}:${numericId}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; numericId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.lastIndexOf(':');
    if (colon < 1) return null;
    const numericId = Number(text.slice(colon + 1));
    if (!Number.isInteger(numericId)) return null;
    return { type: text.slice(0, colon), numericId };
  } catch {
    return null;
  }
}

export class ForgeStore {
  readonly repos = new Map<string, RepoRec>();
  private idCounter = 10_000;
  private clockTick = 0;

  /** The next logical timestamp, as an ISO string. */
  nowIso(): string {
    const sec = EPOCH_SEC + this.clockTick;
    this.clockTick += 1;
    return new Date(sec * 1000).toISOString();
  }

  /** The next logical timestamp as a git author line for the owner. */
  authorLine(): string {
    const sec = EPOCH_SEC + this.clockTick;
    this.clockTick += 1;
    return `${OWNER_NAME} <${OWNER_EMAIL}> ${sec} +0000`;
  }

  nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  createRepo(name: string, description: string, isPrivate: boolean, defaultBranch = 'main'): RepoRec | null {
    const key = `${OWNER_LOGIN}/${name}`;
    if (this.repos.has(key)) return null;
    const stamp = this.nowIso();
    const git = new GitStore();
    git.defaultBranch = defaultBranch;
    const repo: RepoRec = {
      id: this.nextId(),
      name,
      description,
      isPrivate,
      defaultBranch,
      git,
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** A repo is visible only under the token owner's login. */
  getRepo(owner: string, name: string): RepoRec | null {
    if (owner !== OWNER_LOGIN) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  getRepoById(numericId: number): RepoRec | null {
    for (const repo of this.repos.values()) if (repo.id === numericId) return repo;
    return null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== OWNER_LOGIN) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
    const stamp = this.nowIso();
    const issue: IssueRec = {
      kind: 'issue',
      id: this.nextId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
      closedAt: null,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
    const stamp = this.nowIso();
    const pull: PullRec = {
      kind: 'pull',
      id: this.nextId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      baseSha: repo.git.tipOf(`refs/heads/${baseRef}`) ?? ZERO_OID,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  findIssueByGlobalId(id: string): { repo: RepoRec; issue: IssueRec } | null {
    const parsed = parseGlobalId(id);
    if (!parsed) return null;
    for (const repo of this.repos.values()) {
      for (const issue of repo.issues.values()) if (issue.id === parsed.numericId) return { repo, issue };
    }
    return null;
  }

  findPullByGlobalId(id: string): { repo: RepoRec; pull: PullRec } | null {
    const parsed = parseGlobalId(id);
    if (!parsed) return null;
    for (const repo of this.repos.values()) {
      for (const pull of repo.pulls.values()) if (pull.id === parsed.numericId) return { repo, pull };
    }
    return null;
  }
}

// ------------------------------------------------------------ git helpers

/** The branch a ref name or bare branch name denotes, as a full ref. */
export function branchRef(name: string): string {
  return name.startsWith('refs/') ? name : `refs/heads/${name}`;
}

/** Changed paths between two commits, with line counts estimated per file. */
export function diffFiles(
  git: GitStore,
  fromCommit: string | null,
  toCommit: string | null,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const before = fromCommit ? git.filesOf(fromCommit) : new Map();
  const after = toCommit ? git.filesOf(toCommit) : new Map();
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const lineCount = (oid: string | undefined): number => {
    if (!oid) return 0;
    const object = git.get(oid);
    if (!object) return 0;
    const text = object.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length;
  };
  for (const path of [...paths].sort()) {
    const a = before.get(path);
    const b = after.get(path);
    if (a && b && a.oid === b.oid) continue;
    const status = !a ? 'added' : !b ? 'removed' : 'modified';
    const additions = lineCount(b?.oid);
    const deletions = lineCount(a?.oid);
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'unknown' | 'conflict' | 'already' };

/**
 * Squash-merge a pull request onto its base branch: one new commit whose
 * tree is the base tip's tree with the head's changes (relative to the
 * merge base) applied. A path changed on both sides to different bytes
 * since the merge base is a conflict and nothing moves.
 */
export function squashMerge(store: ForgeStore, repo: RepoRec, pull: PullRec): MergeOutcome {
  const git = repo.git;
  const headTip = git.tipOf(branchRef(pull.headRef));
  const baseTip = git.tipOf(branchRef(pull.baseRef));
  if (!headTip || !baseTip) return { ok: false, reason: 'conflict' };
  if (pull.state !== 'open') return { ok: false, reason: 'already' };
  const ancestor = git.mergeBase(headTip, baseTip);
  const baseFiles = git.filesOf(baseTip);
  const ancestorFiles = ancestor ? git.filesOf(ancestor) : new Map<string, { oid: string; mode: string }>();
  const headFiles = git.filesOf(headTip);
  const mergedFiles = new Map(baseFiles);
  const paths = new Set<string>([...ancestorFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const inAncestor = ancestorFiles.get(path);
    const inHead = headFiles.get(path);
    if (inAncestor && inHead && inAncestor.oid === inHead.oid) continue; // unchanged on head side
    if (!inAncestor && !inHead) continue;
    const inBase = baseFiles.get(path);
    const headChanged = (inAncestor?.oid ?? null) !== (inHead?.oid ?? null);
    if (!headChanged) continue;
    const baseChanged = (inAncestor?.oid ?? null) !== (inBase?.oid ?? null);
    if (baseChanged && (inBase?.oid ?? null) !== (inHead?.oid ?? null)) {
      return { ok: false, reason: 'conflict' };
    }
    if (inHead) mergedFiles.set(path, inHead);
    else mergedFiles.delete(path);
  }
  const sha = git.commitFiles({
    files: mergedFiles,
    parents: [baseTip],
    author: store.authorLine(),
    message: `${pull.title} (#${pull.number})`,
  });
  git.refs.set(branchRef(pull.baseRef), sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { ok: true, sha };
}

/** Whether a pull would conflict if merged right now (same test as a merge, dry-run). */
export function pullConflicts(repo: RepoRec, pull: PullRec): boolean {
  const git = repo.git;
  const headTip = git.tipOf(branchRef(pull.headRef));
  const baseTip = git.tipOf(branchRef(pull.baseRef));
  if (!headTip || !baseTip) return true;
  const ancestor = git.mergeBase(headTip, baseTip);
  if (!ancestor) return false;
  if (ancestor === headTip || ancestor === baseTip) return false;
  const ancestorFiles = git.filesOf(ancestor);
  const headFiles = git.filesOf(headTip);
  const baseFiles = git.filesOf(baseTip);
  const paths = new Set<string>([...ancestorFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
  for (const path of paths) {
    const a = ancestorFiles.get(path)?.oid ?? null;
    const h = headFiles.get(path)?.oid ?? null;
    const b = baseFiles.get(path)?.oid ?? null;
    if (a !== h && a !== b && b !== h) return true;
  }
  return false;
}

// ------------------------------------------------------------ JSON views

export function ownerView(): Record<string, unknown> {
  return {
    login: OWNER_LOGIN,
    id: OWNER_ID,
    node_id: globalId('User', OWNER_ID),
    type: 'User',
    site_admin: false,
    name: OWNER_NAME,
    email: OWNER_EMAIL,
    url: `/api/v3/users/${OWNER_LOGIN}`,
    html_url: `/${OWNER_LOGIN}`,
  };
}

export function repoView(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${OWNER_LOGIN}/${repo.name}`,
    private: repo.isPrivate,
    owner: ownerView(),
    html_url: `/${OWNER_LOGIN}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${OWNER_LOGIN}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git:///${OWNER_LOGIN}/${repo.name}.git`,
    ssh_url: `git@localhost:${OWNER_LOGIN}/${repo.name}.git`,
    clone_url: `/${OWNER_LOGIN}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function labelView(label: LabelRec): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

export function issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    url: `/api/v3/repos/${OWNER_LOGIN}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${OWNER_LOGIN}/${repo.name}`,
    html_url: `/${OWNER_LOGIN}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: ownerView(),
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is LabelRec => label !== undefined)
      .map(labelView),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

export function commentView(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: ownerView(),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    url: '',
    html_url: '',
  };
}

export function pullView(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const git = repo.git;
  const headSha = git.tipOf(branchRef(pull.headRef)) ?? ZERO_OID;
  const baseSha = git.tipOf(branchRef(pull.baseRef)) ?? pull.baseSha;
  const refBlock = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${OWNER_LOGIN}:${ref}`,
    ref,
    sha,
    user: ownerView(),
    repo: repoView(repo),
  });
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    url: `/api/v3/repos/${OWNER_LOGIN}/${repo.name}/pulls/${pull.number}`,
    html_url: `/${OWNER_LOGIN}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    locked: false,
    user: ownerView(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.mergedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? !pullConflicts(repo, pull) : null,
    mergeable_state: pull.state === 'open' ? (pullConflicts(repo, pull) ? 'dirty' : 'clean') : 'unknown',
    draft: false,
    head: refBlock(pull.headRef, headSha),
    base: refBlock(pull.baseRef, baseSha),
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

/** One commit as the REST commits list serves it. */
export function commitView(git: GitStore, sha: string): Record<string, unknown> {
  const object = git.get(sha);
  if (!object || object.type !== 'commit') return { sha };
  const view = parseCommit(object.data);
  const person = (line: string): Record<string, unknown> => {
    const match = /^(.*)<([^>]*)>\s+(\d+)\s+([+-]\d{4})$/.exec(line.trim());
    if (!match) return { name: line, email: '', date: new Date(EPOCH_SEC * 1000).toISOString() };
    return {
      name: match[1].trim(),
      email: match[2],
      date: new Date(Number(match[3]) * 1000).toISOString(),
    };
  };
  return {
    sha,
    node_id: globalId('Commit', Number.parseInt(sha.slice(0, 8), 16)),
    commit: {
      author: person(view.author),
      committer: person(view.committer),
      message: view.message.replace(/\n$/, ''),
      tree: { sha: view.tree, url: '' },
      comment_count: 0,
    },
    author: ownerView(),
    committer: ownerView(),
    parents: view.parents.map((parent) => ({ sha: parent, url: '' })),
    url: '',
    html_url: '',
  };
}
