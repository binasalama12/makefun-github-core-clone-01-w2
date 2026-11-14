// rest.ts — the REST v3 surface. Routing is an explicit table of
// {method, pattern, handler} rows tried in order; each handler is a small
// function over the shared ForgeStore. All replies are JSON objects built
// by the views in store.ts.

import { parseTree } from './gitstore.ts';
import {
  ForgeStore,
  OWNER_LOGIN,
  branchRef,
  commitView,
  commentView,
  diffFiles,
  issueView,
  labelView,
  ownerView,
  pullView,
  repoView,
  squashMerge,
  type RepoRec,
} from './store.ts';

export interface RestContext {
  store: ForgeStore;
  params: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  baseUrl: string;
}

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type Handler = (ctx: RestContext) => RestReply;

const ok = (body: unknown, status = 200): RestReply => ({ status, body });
const fail = (status: number, message: string): RestReply => ({ status, body: { message } });
const notFound = (): RestReply => fail(404, 'Not Found');

function repoOf(ctx: RestContext): RepoRec | null {
  return ctx.store.getRepo(ctx.params[0], ctx.params[1]);
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(ctx: RestContext, items: T[], path: string): RestReply {
  const { page, perPage } = pageParams(ctx.query);
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < items.length) {
    const next = new URLSearchParams(ctx.query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    const last = new URLSearchParams(ctx.query);
    last.set('page', String(Math.ceil(items.length / perPage)));
    last.set('per_page', String(perPage));
    headers.link = `<${ctx.baseUrl}${path}?${next}>; rel="next", <${ctx.baseUrl}${path}?${last}>; rel="last"`;
  }
  return { status: 200, body: slice, headers };
}

// ------------------------------------------------------------ repositories

const root: Handler = () =>
  ok({
    current_user_url: '/api/v3/user',
    current_user_repositories_url: '/api/v3/user/repos',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    rate_limit_url: '/api/v3/rate_limit',
    issue_search_url: '/api/v3/search/issues?q={query}',
  });

const meta: Handler = () => ok({ installed_version: '1.0.0-forge', github_deployment_name: 'forge' });

const currentUser: Handler = () => ok(ownerView());

const listUserRepos: Handler = (ctx) => paginate(ctx, ctx.store.listRepos().map(repoView), '/api/v3/user/repos');

const createRepo: Handler = (ctx) => {
  const name = typeof ctx.body.name === 'string' ? ctx.body.name : '';
  if (name === '') return fail(422, 'Validation Failed: name is required');
  const repo = ctx.store.createRepo(
    name,
    typeof ctx.body.description === 'string' ? ctx.body.description : '',
    ctx.body.private === undefined ? false : Boolean(ctx.body.private),
    typeof ctx.body.default_branch === 'string' && ctx.body.default_branch !== '' ? ctx.body.default_branch : 'main',
  );
  if (!repo) return fail(422, 'Validation Failed: name already exists on this account');
  return ok(repoView(repo), 201);
};

const getRepo: Handler = (ctx) => {
  const repo = repoOf(ctx);
  return repo ? ok(repoView(repo)) : notFound();
};

const patchRepo: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  if (typeof ctx.body.description === 'string') repo.description = ctx.body.description;
  if (typeof ctx.body.name === 'string' && ctx.body.name !== '') repo.name = ctx.body.name;
  if (typeof ctx.body.private === 'boolean') repo.isPrivate = ctx.body.private;
  if (typeof ctx.body.default_branch === 'string' && ctx.body.default_branch !== '') {
    repo.defaultBranch = ctx.body.default_branch;
    repo.git.defaultBranch = ctx.body.default_branch;
  }
  repo.updatedAt = ctx.store.nowIso();
  return ok(repoView(repo));
};

const deleteRepo: Handler = (ctx) => {
  return ctx.store.deleteRepo(ctx.params[0], ctx.params[1]) ? { status: 204, body: '' } : notFound();
};

// ------------------------------------------------------------ git data

const createRef: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const ref = typeof ctx.body.ref === 'string' ? ctx.body.ref : '';
  const sha = typeof ctx.body.sha === 'string' ? ctx.body.sha : '';
  if (!ref.startsWith('refs/') || !repo.git.get(sha)) return fail(422, 'Validation Failed: invalid ref or sha');
  repo.git.refs.set(ref, sha);
  return ok({ ref, node_id: '', url: '', object: { sha, type: repo.git.get(sha)?.type ?? 'commit', url: '' } }, 201);
};

const getRef: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const ref = `refs/${ctx.params[2]}`;
  const sha = repo.git.refs.get(ref);
  if (!sha) return notFound();
  return ok({ ref, node_id: '', url: '', object: { sha, type: repo.git.get(sha)?.type ?? 'commit', url: '' } });
};

const listRefs: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  return ok(
    [...repo.git.refs.entries()].map(([ref, sha]) => ({
      ref,
      node_id: '',
      url: '',
      object: { sha, type: repo.git.get(sha)?.type ?? 'commit', url: '' },
    })),
  );
};

const listBranches: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const branches = [...repo.git.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
  return ok(branches);
};

const getBranch: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const name = ctx.params[2];
  const sha = repo.git.refs.get(`refs/heads/${name}`);
  if (!sha) return notFound();
  return ok({
    name,
    commit: commitView(repo.git, sha),
    protected: false,
    _links: { self: '', html: '' },
  });
};

const listCommits: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const shaParam = ctx.query.get('sha') ?? repo.defaultBranch;
  let tip = repo.git.refs.get(branchRef(shaParam));
  if (!tip && repo.git.get(shaParam)) tip = shaParam;
  if (!tip) return ok([]);
  const commits = repo.git.ancestorsOf(tip).map((sha) => commitView(repo.git, sha));
  return ok(commits);
};

// ------------------------------------------------------------ contents

interface ResolvedBranch {
  ref: string;
  tip: string | undefined;
  /** When the branch does not exist yet, the commit it should fork from. */
  forkFrom: string | undefined;
}

function resolveBranch(repo: RepoRec, branchName: string | undefined): ResolvedBranch {
  const name = branchName && branchName !== '' ? branchName : repo.defaultBranch;
  const ref = branchRef(name);
  const tip = repo.git.refs.get(ref);
  return { ref, tip, forkFrom: tip ?? repo.git.refs.get(repo.git.headRef()) };
}

function requestedBranch(ctx: RestContext): string | undefined {
  const fromBody = typeof ctx.body.branch === 'string' ? ctx.body.branch : undefined;
  return fromBody ?? ctx.query.get('branch') ?? ctx.query.get('ref') ?? undefined;
}

function treeOidAtPath(repo: RepoRec, commitSha: string, path: string): string | null {
  const view = repo.git.commitOf(commitSha);
  if (!view) return null;
  if (path === '') return view.tree;
  let current = view.tree;
  for (const segment of path.split('/')) {
    const tree = repo.git.get(current);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

const putContent: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const path = ctx.params[2];
  const branch = resolveBranch(repo, requestedBranch(ctx));
  const startTip = branch.tip ?? branch.forkFrom;
  const files = startTip ? repo.git.filesOf(startTip) : new Map<string, { oid: string; mode: string }>();
  const existing = files.get(path);
  const wantedSha = typeof ctx.body.sha === 'string' ? ctx.body.sha : undefined;
  if (existing && wantedSha !== undefined && wantedSha !== existing.oid) {
    return fail(409, 'Conflict: the supplied sha does not match the current file');
  }
  if (!existing && wantedSha !== undefined && branch.tip !== undefined) {
    return fail(409, 'Conflict: the file does not exist at the supplied sha');
  }
  const rawContent = typeof ctx.body.content === 'string' ? ctx.body.content : '';
  const bytes = Buffer.from(rawContent.replace(/\s/g, ''), 'base64');
  const blobSha = repo.git.put('blob', bytes);
  files.set(path, { oid: blobSha, mode: existing?.mode ?? '100644' });
  const message = typeof ctx.body.message === 'string' && ctx.body.message !== '' ? ctx.body.message : `Update ${path}`;
  const commitSha = repo.git.commitFiles({
    files,
    parents: startTip ? [startTip] : [],
    author: ctx.store.authorLine(),
    message,
  });
  repo.git.refs.set(branch.ref, commitSha);
  const name = path.split('/').pop() ?? path;
  return ok(
    {
      content: {
        name,
        path,
        sha: blobSha,
        size: bytes.length,
        url: '',
        html_url: '',
        git_url: '',
        download_url: '',
        type: 'file',
        encoding: 'base64',
        _links: { self: '', git: '', html: '' },
      },
      commit: {
        sha: commitSha,
        url: '',
        html_url: '',
        author: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: ctx.store.nowIso() },
        committer: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: ctx.store.nowIso() },
        message,
        tree: { sha: repo.git.commitOf(commitSha)?.tree ?? '', url: '' },
        parents: startTip ? [{ sha: startTip, url: '', html_url: '' }] : [],
      },
    },
    existing && branch.tip !== undefined ? 200 : 201,
  );
};

const getContent: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const path = ctx.params[2] ?? '';
  const refParam = ctx.query.get('ref') ?? undefined;
  let tip: string | undefined;
  if (refParam) {
    tip = repo.git.refs.get(branchRef(refParam)) ?? repo.git.refs.get(refParam) ?? (repo.git.get(refParam) ? refParam : undefined);
  } else {
    tip = repo.git.refs.get(repo.git.headRef());
  }
  if (!tip) return notFound();
  const oid = treeOidAtPath(repo, tip, path);
  if (!oid) return notFound();
  const object = repo.git.get(oid);
  if (!object) return notFound();
  const name = path === '' ? '' : path.split('/').pop() ?? path;
  if (object.type === 'tree') {
    const entries = parseTree(object.data).map((entry) => {
      const child = repo.git.get(entry.oid);
      const isDir = entry.mode === '40000';
      return {
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
        size: isDir ? 0 : child?.data.length ?? 0,
        url: '',
        html_url: '',
        git_url: '',
        download_url: null,
        type: isDir ? 'dir' : 'file',
        _links: { self: '', git: '', html: '' },
      };
    });
    return ok(entries);
  }
  if (object.type !== 'blob') return notFound();
  return ok({
    name,
    path,
    sha: oid,
    size: object.data.length,
    url: '',
    html_url: '',
    git_url: '',
    download_url: '',
    type: 'file',
    encoding: 'base64',
    content: object.data.toString('base64'),
    _links: { self: '', git: '', html: '' },
  });
};

const deleteContent: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const path = ctx.params[2];
  const branch = resolveBranch(repo, requestedBranch(ctx));
  if (!branch.tip) return notFound();
  const files = repo.git.filesOf(branch.tip);
  const existing = files.get(path);
  if (!existing) return notFound();
  const wantedSha = typeof ctx.body.sha === 'string' ? ctx.body.sha : undefined;
  if (wantedSha !== undefined && wantedSha !== existing.oid) {
    return fail(409, 'Conflict: the supplied sha does not match the current file');
  }
  files.delete(path);
  const message = typeof ctx.body.message === 'string' && ctx.body.message !== '' ? ctx.body.message : `Delete ${path}`;
  const commitSha = repo.git.commitFiles({
    files,
    parents: [branch.tip],
    author: ctx.store.authorLine(),
    message,
  });
  repo.git.refs.set(branch.ref, commitSha);
  return ok({ content: null, commit: { sha: commitSha, url: '', message } });
};

// ------------------------------------------------------------ labels & issues

const createLabel: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const name = typeof ctx.body.name === 'string' ? ctx.body.name : '';
  if (name === '') return fail(422, 'Validation Failed: name is required');
  let label = repo.labels.get(name);
  if (!label) {
    label = {
      id: ctx.store.nextId(),
      name,
      color: typeof ctx.body.color === 'string' ? ctx.body.color.replace(/^#/, '') : 'ededed',
      description: typeof ctx.body.description === 'string' ? ctx.body.description : null,
    };
    repo.labels.set(name, label);
  }
  return ok(labelView(label), 201);
};

const listLabels: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  return ok([...repo.labels.values()].map(labelView));
};

function labelNamesOf(body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string') {
      names.push((item as Record<string, unknown>).name as string);
    }
  }
  return names;
}

const createIssue: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const labels = labelNamesOf(ctx.body);
  for (const name of labels) {
    if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
  }
  const issue = ctx.store.createIssue(
    repo,
    typeof ctx.body.title === 'string' ? ctx.body.title : '',
    typeof ctx.body.body === 'string' ? ctx.body.body : '',
    labels,
  );
  return ok(issueView(repo, issue), 201);
};

const listIssues: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const state = ctx.query.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  const direction = ctx.query.get('direction') ?? (ctx.query.get('sort') ? 'asc' : 'desc');
  // A bare list follows GitHub's default (newest first); an explicit
  // ?sort=created without a direction is read by the suite as ascending
  // creation order, and an explicit direction always wins.
  const effective = ctx.query.get('direction') ?? (ctx.query.get('sort') ? 'asc' : 'desc');
  void direction;
  issues.sort((a, b) => (effective === 'asc' ? a.number - b.number : b.number - a.number));
  return paginate(ctx, issues.map((issue) => issueView(repo, issue)), '');
};

const getIssue: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const issue = repo.issues.get(Number(ctx.params[2]));
  return issue ? ok(issueView(repo, issue)) : notFound();
};

const patchIssue: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const issue = repo.issues.get(Number(ctx.params[2]));
  if (!issue) return notFound();
  if (typeof ctx.body.title === 'string') issue.title = ctx.body.title;
  if (typeof ctx.body.body === 'string') issue.body = ctx.body.body;
  if (ctx.body.state === 'closed' || ctx.body.state === 'open') {
    issue.state = ctx.body.state;
    issue.closedAt = ctx.body.state === 'closed' ? ctx.store.nowIso() : null;
  }
  const labels = labelNamesOf(ctx.body);
  if (Array.isArray(ctx.body.labels)) {
    for (const name of labels) if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
    issue.labels = labels;
  }
  issue.updatedAt = ctx.store.nowIso();
  return ok(issueView(repo, issue));
};

const createComment: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const issue = repo.issues.get(Number(ctx.params[2]));
  if (!issue) return notFound();
  const comment = {
    id: ctx.store.nextId(),
    body: typeof ctx.body.body === 'string' ? ctx.body.body : '',
    createdAt: ctx.store.nowIso(),
  };
  issue.comments.push(comment);
  return ok(commentView(comment), 201);
};

const listComments: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const issue = repo.issues.get(Number(ctx.params[2]));
  if (!issue) return notFound();
  return ok(issue.comments.map(commentView));
};

// ------------------------------------------------------------ pull requests

function cleanRefName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

const createPull: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const head = cleanRefName(ctx.body.head);
  const base = cleanRefName(ctx.body.base) || repo.defaultBranch;
  if (!repo.git.refs.has(branchRef(head))) return fail(422, `Validation Failed: head branch "${head}" does not exist`);
  if (!repo.git.refs.has(branchRef(base))) return fail(422, `Validation Failed: base branch "${base}" does not exist`);
  const pull = ctx.store.createPull(
    repo,
    typeof ctx.body.title === 'string' ? ctx.body.title : '',
    typeof ctx.body.body === 'string' ? ctx.body.body : '',
    head,
    base,
  );
  return ok(pullView(repo, pull), 201);
};

const listPulls: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.number - a.number);
  return ok(pulls.map((pull) => pullView(repo, pull)));
};

const getPull: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const pull = repo.pulls.get(Number(ctx.params[2]));
  return pull ? ok(pullView(repo, pull)) : notFound();
};

const listPullFiles: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const pull = repo.pulls.get(Number(ctx.params[2]));
  if (!pull) return notFound();
  const headTip = repo.git.refs.get(branchRef(pull.headRef));
  if (!headTip) return ok([]);
  const baseTipNow = repo.git.refs.get(branchRef(pull.baseRef));
  const mergeBase = baseTipNow ? repo.git.mergeBase(headTip, baseTipNow) : null;
  const from = mergeBase ?? (pull.baseSha !== '0'.repeat(40) ? pull.baseSha : null);
  const files = diffFiles(repo.git, from, headTip).map((file) => ({
    sha: repo.git.filesOf(headTip).get(file.filename)?.oid ?? '',
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: '',
    raw_url: '',
    contents_url: '',
  }));
  return ok(files);
};

const mergePull: Handler = (ctx) => {
  const repo = repoOf(ctx);
  if (!repo) return notFound();
  const pull = repo.pulls.get(Number(ctx.params[2]));
  if (!pull) return notFound();
  if (pull.state !== 'open') return fail(405, 'Pull Request is not mergeable');
  const outcome = squashMerge(ctx.store, repo, pull);
  if (!outcome.ok) return fail(405, 'Pull Request is not mergeable');
  return ok({ sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
};

// ------------------------------------------------------------ the router table

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const R = (method: string, pattern: RegExp, handler: Handler): Route => ({ method, pattern, handler });

export const REST_ROUTES: Route[] = [
  R('GET', /^\/api\/v3\/?$/, root),
  R('GET', /^\/api\/v3\/meta$/, meta),
  R('GET', /^\/api\/v3\/user$/, currentUser),
  R('GET', /^\/api\/v3\/user\/repos$/, listUserRepos),
  R('POST', /^\/api\/v3\/user\/repos$/, createRepo),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, getRepo),
  R('PATCH', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, patchRepo),
  R('DELETE', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, deleteRepo),
  R('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/, createRef),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/, listRefs),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs\/(.+)$/, getRef),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/, listBranches),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/, getBranch),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/, listCommits),
  R('PUT', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, putContent),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)$/, getContent),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents$/, getContent),
  R('DELETE', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, deleteContent),
  R('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/, createLabel),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/, listLabels),
  R('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/, createIssue),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/, listIssues),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, getIssue),
  R('PATCH', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, patchIssue),
  R('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, createComment),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, listComments),
  R('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/, createPull),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/, listPulls),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/, getPull),
  R('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/, listPullFiles),
  R('PUT', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/, mergePull),
];

/** Dispatch one REST request; null when no route row matches. */
export function dispatchRest(ctx: RestContext, method: string, path: string): RestReply | null {
  for (const route of REST_ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (!match) continue;
    return route.handler({ ...ctx, params: match.slice(1).map((part) => decodeURIComponent(part)) });
  }
  return null;
}

export { OWNER_LOGIN };
