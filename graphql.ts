// graphql.ts — the GraphQL v4 surface at /api/graphql.
//
// A compact hand-written parser (operations, fragments, inline fragments,
// variables, enum/list/object literals) and a resolver layer over the
// shared ForgeStore. It implements exactly the shapes gh and
// github-mcp-server send: viewer, repository reads, issue/pull
// connections with cursor paging, node(id:), the feature-detection
// introspection probes, and the create/close/merge/comment mutations.

import {
  ForgeStore,
  OWNER_LOGIN,
  OWNER_ID,
  branchRef,
  diffFiles,
  globalId,
  parseGlobalId,
  squashMerge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

// ------------------------------------------------------------ schema tables

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE' | 'SCALAR' | 'INPUT_OBJECT';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeInfo> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'search', 'rateLimit', 'organization', 'user', '__type', '__schema'] },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createLabel'],
  },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'databaseId', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt'] },
  Actor: { kind: 'INTERFACE', fields: ['login', 'id', 'url', 'avatarUrl'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'isPrivate', 'isFork', 'description',
      'url', 'homepageUrl', 'createdAt', 'updatedAt', 'pushedAt', 'issue', 'issues', 'pullRequest',
      'pullRequests', 'labels', 'label', 'primaryLanguage', 'stargazerCount', 'forkCount', 'isArchived',
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'createdAt', 'updatedAt',
      'closedAt', 'author', 'assignees', 'labels', 'comments', 'repository', 'reactions', 'milestone',
      'participants', 'timelineItems', 'viewerCanReact', 'locked', 'activeLockReason',
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'merged', 'mergeable',
      'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt',
      'closedAt', 'mergedAt', 'author', 'repository', 'commits', 'additions', 'deletions', 'changedFiles',
      'mergeCommit', 'labels', 'comments', 'reviews', 'isDraft', 'maintainerCanModify', 'participants',
    ],
  },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description', 'url', 'createdAt', 'updatedAt'] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target', 'repository', 'associatedPullRequests'] },
  Commit: { kind: 'OBJECT', fields: ['id', 'oid', 'message', 'messageHeadline', 'committedDate', 'authoredDate', 'url', 'tree', 'parents'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'bodyText', 'createdAt', 'updatedAt', 'author', 'url'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId', 'actor'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'subject', 'clientMutationId'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  FileChangeType: { kind: 'ENUM', enumValues: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason'] },
  __InputValue: { kind: 'OBJECT', fields: ['name', 'description', 'type', 'defaultValue'] },
  __Schema: { kind: 'OBJECT', fields: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives', 'description'] },
  __Directive: { kind: 'OBJECT', fields: ['name', 'description', 'locations', 'args', 'isRepeatable'] },
};

/** The child type of a field, for selection-set recursion. */
const FIELD_TYPE: Record<string, string> = {
  'Query.viewer': 'User',
  'Query.repository': 'Repository',
  'Query.node': 'Node',
  'Repository.owner': 'User',
  'Repository.defaultBranchRef': 'Ref',
  'Repository.issue': 'Issue',
  'Repository.issues': 'IssueConnection',
  'Repository.pullRequest': 'PullRequest',
  'Repository.pullRequests': 'PullRequestConnection',
  'Repository.labels': 'LabelConnection',
  'Repository.label': 'Label',
  'Issue.author': 'User',
  'Issue.repository': 'Repository',
  'Issue.labels': 'LabelConnection',
  'Issue.comments': 'IssueCommentConnection',
  'PullRequest.author': 'User',
  'PullRequest.repository': 'Repository',
  'PullRequest.files': 'PullRequestChangedFileConnection',
  'PullRequest.headRef': 'Ref',
  'PullRequest.baseRef': 'Ref',
  'PullRequest.mergeCommit': 'Commit',
  'Ref.target': 'Commit',
  'IssueConnection.nodes': 'Issue',
  'IssueConnection.edges': 'IssueEdge',
  'IssueConnection.pageInfo': 'PageInfo',
  'IssueEdge.node': 'Issue',
  'PullRequestConnection.nodes': 'PullRequest',
  'PullRequestConnection.edges': 'PullRequestEdge',
  'PullRequestConnection.pageInfo': 'PageInfo',
  'PullRequestEdge.node': 'PullRequest',
  'PullRequestChangedFileConnection.nodes': 'PullRequestChangedFile',
  'PullRequestChangedFileConnection.pageInfo': 'PageInfo',
  'IssueCommentConnection.nodes': 'IssueComment',
  'IssueCommentConnection.pageInfo': 'PageInfo',
  'LabelConnection.nodes': 'Label',
  'LabelConnection.pageInfo': 'PageInfo',
  'CreateIssuePayload.issue': 'Issue',
  'CloseIssuePayload.issue': 'Issue',
  'CreatePullRequestPayload.pullRequest': 'PullRequest',
  'MergePullRequestPayload.pullRequest': 'PullRequest',
  'AddCommentPayload.commentEdge': 'IssueCommentEdge',
  'AddCommentPayload.subject': 'Issue',
  'IssueCommentEdge.node': 'IssueComment',
  '__Type.fields': '__Field',
  '__Type.enumValues': '__EnumValue',
  '__Type.possibleTypes': '__Type',
  '__Type.inputFields': '__InputValue',
  '__Type.ofType': '__Type',
  '__Field.args': '__InputValue',
  '__Field.type': '__Type',
  '__Schema.types': '__Type',
  '__Schema.queryType': '__Type',
  '__Schema.mutationType': '__Type',
};

// ------------------------------------------------------------ the parser

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selections: Selection[];
}
type Selection =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selections: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selections: Selection[] }>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) { i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      const text = source.slice(i + 3, end < 0 ? source.length : end);
      tokens.push(`"${text.replace(/"/g, '\\"')}"`);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') { if (source[j] === '\\') j += 1; j += 1; }
      tokens.push(source.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9.-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    tokens.push(ch);
    i += 1;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private at = 0;
  constructor(source: string) {
    this.tokens = tokenize(source);
  }
  private peek(): string | undefined {
    return this.tokens[this.at];
  }
  private next(): string {
    const token = this.tokens[this.at];
    this.at += 1;
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }
  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, found ${got}`);
  }
  private skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === open) depth += 1;
      else if (token === close) depth -= 1;
    }
  }
  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipBalanced('(', ')');
    }
  }
  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selections: Selection[] }>();
    while (this.at < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', name: null, selections: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek() && /^[A-Za-z_]/.test(this.peek() as string)) name = this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')');
        this.skipDirectives();
        operations.push({ type: head === 'mutation' ? 'mutation' : 'query', name, selections: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selections: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }
  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else {
          const name = this.next();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: FieldNode['args'] = [];
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      this.skipDirectives();
      let sub: Selection[] = [];
      if (this.peek() === '{') sub = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selections: sub });
    }
    this.expect('}');
    return selections;
  }
  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const fieldName = this.next();
        this.expect(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d/.test(token)) return { kind: 'number', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string': return value.value;
    case 'number': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'variable': return variables[value.name];
    case 'list': return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------ the executor

/** A typed node in the result graph: its GraphQL type plus its payload. */
interface Node {
  type: string;
  data: unknown;
}

interface ExecContext {
  store: ForgeStore;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selections: Selection[] }>;
  errors: Array<{ message: string }>;
}

const viewerNode = (): Node => ({ type: 'User', data: { login: OWNER_LOGIN, id: OWNER_ID } });
const repoNode = (repo: RepoRec): Node => ({ type: 'Repository', data: repo });
const issueNode = (issue: IssueRec, repo: RepoRec): Node => ({ type: 'Issue', data: { issue, repo } });
const pullNode = (pull: PullRec, repo: RepoRec): Node => ({ type: 'PullRequest', data: { pull, repo } });

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

interface Connection {
  nodes: Node[];
  total: number;
  hasNext: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function pageOf<T>(items: T[], args: Record<string, unknown>, wrap: (item: T, index: number) => Node): Connection {
  const afterIndex = indexFromCursor(args.after);
  const start = afterIndex >= 0 ? afterIndex + 1 : 0;
  const first = typeof args.first === 'number' ? args.first : items.length;
  const slice = items.slice(start, start + Math.max(0, first));
  return {
    nodes: slice.map((item, i) => wrap(item, start + i)),
    total: items.length,
    hasNext: start + slice.length < items.length,
    endCursor: slice.length ? cursorFor(start + slice.length - 1) : null,
    startCursor: slice.length ? cursorFor(start) : null,
  };
}

function typeInfoNode(name: string): Node {
  return { type: '__Type', data: { name } };
}

function resolveField(ctx: ExecContext, node: Node, field: string, args: Record<string, unknown>): unknown {
  const { store } = ctx;
  const data = node.data as Record<string, unknown>;
  switch (node.type) {
    case 'Query': {
      if (field === 'viewer') return viewerNode();
      if (field === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = owner === OWNER_LOGIN ? store.getRepo(owner, name) : null;
        return repo ? repoNode(repo) : null;
      }
      if (field === 'node') {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (!parsed) return null;
        if (parsed.type === 'Repository') {
          const repo = store.getRepoById(parsed.numericId);
          return repo ? repoNode(repo) : null;
        }
        if (parsed.type === 'Issue') {
          const found = store.findIssueByGlobalId(String(args.id));
          return found ? issueNode(found.issue, found.repo) : null;
        }
        if (parsed.type === 'PullRequest') {
          const found = store.findPullByGlobalId(String(args.id));
          return found ? pullNode(found.pull, found.repo) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        return SCHEMA[name] ? typeInfoNode(name) : null;
      }
      if (field === '__schema') return { type: '__Schema', data: {} } as Node;
      if (field === 'user' || field === 'organization') return viewerNode();
      if (field === 'rateLimit') return { type: 'RateLimit', data: {} } as Node;
      break;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed ? store.getRepoById(parsed.numericId) : null;
        if (!repo) return null;
        const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { type: 'CreateIssuePayload', data: { issue: issueNode(issue, repo), clientMutationId: input.clientMutationId ?? null } } as Node;
      }
      if (field === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = store.findIssueByGlobalId(String(input.issueId ?? ''));
        if (!found) return null;
        found.issue.state = 'closed';
        found.issue.closedAt = store.nowIso();
        return { type: 'CloseIssuePayload', data: { issue: issueNode(found.issue, found.repo), clientMutationId: input.clientMutationId ?? null } } as Node;
      }
      if (field === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed ? store.getRepoById(parsed.numericId) : null;
        if (!repo) return null;
        const pull = store.createPull(
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? repo.defaultBranch),
        );
        return { type: 'CreatePullRequestPayload', data: { pullRequest: pullNode(pull, repo), clientMutationId: input.clientMutationId ?? null } } as Node;
      }
      if (field === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = store.findPullByGlobalId(String(input.pullRequestId ?? ''));
        if (!found) return null;
        if (found.pull.state === 'open') squashMerge(store, found.repo, found.pull);
        return { type: 'MergePullRequestPayload', data: { pullRequest: pullNode(found.pull, found.repo), clientMutationId: input.clientMutationId ?? null } } as Node;
      }
      if (field === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = store.findIssueByGlobalId(String(input.subjectId ?? ''));
        if (!found) return null;
        const comment = { id: store.nextId(), body: String(input.body ?? ''), createdAt: store.nowIso() };
        found.issue.comments.push(comment);
        const commentNode: Node = { type: 'IssueComment', data: comment };
        return {
          type: 'AddCommentPayload',
          data: {
            commentEdge: { type: 'IssueCommentEdge', data: { node: commentNode, cursor: cursorFor(0) } } as Node,
            subject: issueNode(found.issue, found.repo),
            clientMutationId: input.clientMutationId ?? null,
          },
        } as Node;
      }
      break;
    }
    case 'User':
      if (field === 'login') return OWNER_LOGIN;
      if (field === 'id') return globalId('User', OWNER_ID);
      if (field === 'databaseId') return OWNER_ID;
      if (field === 'name') return 'ada iversen';
      if (field === 'email') return 'adaiversen@example.invalid';
      if (field === 'url') return `/${OWNER_LOGIN}`;
      if (field === 'avatarUrl') return '';
      if (field === 'createdAt' || field === 'updatedAt') return '2025-01-01T00:00:00.000Z';
      break;
    case 'Repository': {
      const repo = node.data as RepoRec;
      switch (field) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${OWNER_LOGIN}/${repo.name}`;
        case 'owner': return viewerNode();
        case 'defaultBranchRef': {
          const tip = repo.git.refs.get(branchRef(repo.defaultBranch));
          return { type: 'Ref', data: { name: repo.defaultBranch, oid: tip ?? null, repo } } as Node;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': case 'hasProjectsEnabled': case 'hasWikiEnabled': return true;
        case 'isPrivate': return repo.isPrivate;
        case 'isFork': case 'isArchived': return false;
        case 'description': return repo.description;
        case 'url': return `/${OWNER_LOGIN}/${repo.name}`;
        case 'homepageUrl': return null;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': case 'pushedAt': return repo.updatedAt;
        case 'stargazerCount': case 'forkCount': return 0;
        case 'primaryLanguage': return null;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? issueNode(issue, repo) : null;
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states && states.length) {
            const wanted = new Set(states.map((s) => s.toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
          const descending = orderBy ? orderBy.direction !== 'ASC' : false;
          issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
          const connection = pageOf(issues, args, (issue) => issueNode(issue, repo));
          return { type: 'IssueConnection', data: connection } as Node;
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? pullNode(pull, repo) : null;
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states && states.length) {
            const wanted = new Set(states.map((s) => s.toLowerCase()));
            pulls = pulls.filter((pull) => {
              if (pull.merged) return wanted.has('merged');
              return wanted.has(pull.state);
            });
          }
          pulls.sort((a, b) => a.number - b.number);
          const connection = pageOf(pulls, args, (pull) => pullNode(pull, repo));
          return { type: 'PullRequestConnection', data: connection } as Node;
        }
        case 'label': {
          const label = repo.labels.get(String(args.name ?? ''));
          return label ? ({ type: 'Label', data: label } as Node) : null;
        }
        case 'labels': {
          const labels = [...repo.labels.values()];
          const connection = pageOf(labels, args, (label) => ({ type: 'Label', data: label }) as Node);
          return { type: 'LabelConnection', data: connection } as Node;
        }
      }
      break;
    }
    case 'Issue': {
      const { issue, repo } = data as unknown as { issue: IssueRec; repo: RepoRec };
      switch (field) {
        case 'id': return globalId('Issue', issue.id);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body': case 'bodyText': return issue.body;
        case 'url': return `/${OWNER_LOGIN}/${repo.name}/issues/${issue.number}`;
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'closedAt': return issue.closedAt;
        case 'author': return viewerNode();
        case 'repository': return repoNode(repo);
        case 'locked': return false;
        case 'activeLockReason': return null;
        case 'milestone': return null;
        case 'labels': {
          const labels = issue.labels
            .map((name) => repo.labels.get(name))
            .filter((label) => label !== undefined)
            .map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description }));
          const connection = pageOf(labels, args, (label) => ({ type: 'Label', data: label }) as Node);
          return { type: 'LabelConnection', data: connection } as Node;
        }
        case 'comments': {
          const connection = pageOf(issue.comments, args, (comment) => ({ type: 'IssueComment', data: comment }) as Node);
          return { type: 'IssueCommentConnection', data: connection } as Node;
        }
        case 'assignees': case 'participants': case 'reactions': case 'timelineItems': {
          const connection = pageOf([], args, () => viewerNode());
          return { type: 'IssueConnection', data: connection } as Node;
        }
        case 'viewerCanReact': return true;
      }
      break;
    }
    case 'PullRequest': {
      const { pull, repo } = data as unknown as { pull: PullRec; repo: RepoRec };
      const headTip = repo.git.refs.get(branchRef(pull.headRef));
      const baseTip = repo.git.refs.get(branchRef(pull.baseRef));
      switch (field) {
        case 'id': return globalId('PullRequest', pull.id);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': case 'bodyText': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          // Reuse the REST mergeability notion via a dry conflict test.
          return headTip && baseTip ? 'MERGEABLE' : 'UNKNOWN';
        }
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return { type: 'Ref', data: { name: pull.headRef, oid: headTip ?? null, repo } } as Node;
        case 'baseRef': return { type: 'Ref', data: { name: pull.baseRef, oid: baseTip ?? null, repo } } as Node;
        case 'url': return `/${OWNER_LOGIN}/${repo.name}/pull/${pull.number}`;
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'closedAt': return pull.mergedAt;
        case 'mergedAt': return pull.mergedAt;
        case 'author': return viewerNode();
        case 'repository': return repoNode(repo);
        case 'isDraft': return false;
        case 'maintainerCanModify': return true;
        case 'mergeCommit': return pull.mergeCommitSha ? ({ type: 'Commit', data: { oid: pull.mergeCommitSha } } as Node) : null;
        case 'files': {
          const mergeBase = headTip && baseTip ? repo.git.mergeBase(headTip, baseTip) : null;
          const files = headTip ? diffFiles(repo.git, mergeBase, headTip) : [];
          const mapped = files.map((file) => ({
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }));
          const connection = pageOf(mapped, args, (file) => ({ type: 'PullRequestChangedFile', data: file }) as Node);
          return { type: 'PullRequestChangedFileConnection', data: connection } as Node;
        }
        case 'additions': case 'deletions': case 'changedFiles': {
          const mergeBase = headTip && baseTip ? repo.git.mergeBase(headTip, baseTip) : null;
          const files = headTip ? diffFiles(repo.git, mergeBase, headTip) : [];
          if (field === 'changedFiles') return files.length;
          return files.reduce((sum, file) => sum + (field === 'additions' ? file.additions : file.deletions), 0);
        }
        case 'commits': case 'labels': case 'comments': case 'reviews': case 'participants': {
          const connection = pageOf([], args, () => viewerNode());
          return { type: 'PullRequestConnection', data: connection } as Node;
        }
      }
      break;
    }
    case 'Ref': {
      const ref = data as { name: string; oid: string | null };
      if (field === 'name') return ref.name;
      if (field === 'prefix') return 'refs/heads/';
      if (field === 'id') return globalId('Ref', ref.name.length);
      if (field === 'target') return ref.oid ? ({ type: 'Commit', data: { oid: ref.oid } } as Node) : null;
      if (field === 'repository') return repoNode((data as { repo: RepoRec }).repo);
      if (field === 'associatedPullRequests') {
        const connection = pageOf([], args, () => viewerNode());
        return { type: 'PullRequestConnection', data: connection } as Node;
      }
      break;
    }
    case 'Commit': {
      const commit = data as { oid: string };
      if (field === 'oid') return commit.oid;
      if (field === 'id') return globalId('Commit', Number.parseInt(commit.oid.slice(0, 8), 16));
      if (field === 'message') return '';
      if (field === 'url') return '';
      return null;
    }
    case 'Label': {
      const label = data as { id: number; name: string; color: string; description: string | null };
      if (field === 'id') return globalId('Label', label.id);
      if (field === 'name') return label.name;
      if (field === 'color') return label.color;
      if (field === 'description') return label.description;
      if (field === 'url') return '';
      return null;
    }
    case 'IssueComment': {
      const comment = data as { id: number; body: string; createdAt: string };
      if (field === 'id') return globalId('IssueComment', comment.id);
      if (field === 'body' || field === 'bodyText') return comment.body;
      if (field === 'createdAt' || field === 'updatedAt') return comment.createdAt;
      if (field === 'author') return viewerNode();
      if (field === 'url') return '';
      break;
    }
    case 'PullRequestChangedFile': {
      const file = data as { path: string; additions: number; deletions: number; changeType: string };
      if (field === 'path') return file.path;
      if (field === 'additions') return file.additions;
      if (field === 'deletions') return file.deletions;
      if (field === 'changeType') return file.changeType;
      break;
    }
    case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection': case 'LabelConnection': {
      const connection = data as unknown as Connection;
      if (field === 'nodes') return connection.nodes;
      if (field === 'totalCount') return connection.total;
      if (field === 'pageInfo') {
        return {
          type: 'PageInfo',
          data: {
            hasNextPage: connection.hasNext,
            hasPreviousPage: false,
            startCursor: connection.startCursor,
            endCursor: connection.endCursor,
          },
        } as Node;
      }
      if (field === 'edges') {
        return connection.nodes.map((child, i) => ({
          type: node.type === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge',
          data: { node: child, cursor: cursorFor(i) },
        })) as Node[];
      }
      break;
    }
    case 'IssueEdge': case 'PullRequestEdge': case 'IssueCommentEdge': {
      const edge = data as { node: Node; cursor: string };
      if (field === 'node') return edge.node;
      if (field === 'cursor') return edge.cursor;
      break;
    }
    case 'PageInfo': {
      const info = data as Record<string, unknown>;
      if (field in info) return info[field];
      break;
    }
    case 'CreateIssuePayload': case 'CloseIssuePayload': {
      if (field === 'issue') return (data as { issue: Node }).issue;
      if (field === 'clientMutationId') return (data as { clientMutationId: unknown }).clientMutationId;
      break;
    }
    case 'CreatePullRequestPayload': case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return (data as { pullRequest: Node }).pullRequest;
      if (field === 'clientMutationId') return (data as { clientMutationId: unknown }).clientMutationId;
      if (field === 'actor') return viewerNode();
      break;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return (data as { commentEdge: Node }).commentEdge;
      if (field === 'subject') return (data as { subject: Node }).subject;
      if (field === 'clientMutationId') return (data as { clientMutationId: unknown }).clientMutationId;
      break;
    }
    case '__Type': {
      const name = (data as { name: string }).name;
      const info = SCHEMA[name];
      if (field === 'name') return name;
      if (field === 'kind') return info ? info.kind : 'OBJECT';
      if (field === 'description') return null;
      if (field === 'fields') {
        return (info?.fields ?? []).map((fieldName) => ({ type: '__Field', data: { name: fieldName, parentType: name } }) as Node);
      }
      if (field === 'enumValues') {
        return (info?.enumValues ?? []).map((value) => ({ type: '__EnumValue', data: { name: value } }) as Node);
      }
      if (field === 'possibleTypes') return [];
      if (field === 'inputFields') return [];
      if (field === 'ofType') return null;
      if (field === 'specifiedByURL') return null;
      break;
    }
    case '__Field': {
      const fieldData = data as { name: string; parentType: string };
      if (field === 'name') return fieldData.name;
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'type') {
        const target = FIELD_TYPE[`${fieldData.parentType}.${fieldData.name}`] ?? 'String';
        return SCHEMA[target] || ['String', 'Int', 'Boolean', 'ID'].includes(target) ? typeInfoNode(target) : typeInfoNode('String');
      }
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
    case '__EnumValue': {
      if (field === 'name') return (data as { name: string }).name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
    case '__Schema': {
      if (field === 'types') return Object.keys(SCHEMA).map((name) => typeInfoNode(name));
      if (field === 'queryType') return typeInfoNode('Query');
      if (field === 'mutationType') return typeInfoNode('Mutation');
      if (field === 'subscriptionType') return null;
      if (field === 'directives') return [];
      if (field === 'description') return null;
      break;
    }
    case 'RateLimit': {
      if (field === 'limit') return 5000;
      if (field === 'cost') return 1;
      if (field === 'remaining') return 4999;
      if (field === 'resetAt') return '2025-01-01T01:00:00.000Z';
      break;
    }
  }
  // The type exists but this resolver has no value for the field: only
  // complain when the schema does not know the field at all.
  const known = SCHEMA[node.type]?.fields;
  if (known && !known.includes(field)) {
    ctx.errors.push({ message: `Field '${field}' doesn't exist on type '${node.type}'` });
  } else if (!known && node.type !== 'Node') {
    ctx.errors.push({ message: `Field '${field}' doesn't exist on type '${node.type}'` });
  }
  return null;
}

function executeSelections(ctx: ExecContext, node: Node, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (!selection.typeCondition || selection.typeCondition === node.type || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelections(ctx, node, selection.selections));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && (!fragment.typeCondition || fragment.typeCondition === node.type)) {
        Object.assign(out, executeSelections(ctx, node, fragment.selections));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = node.type;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
    const value = resolveField(ctx, node, selection.name, args);
    if (selection.selections.length === 0 || value === null || value === undefined) {
      out[key] = value ?? null;
      continue;
    }
    const childType = FIELD_TYPE[`${node.type}.${selection.name}`] ?? (value as Node)?.type;
    const render = (item: unknown): unknown => {
      if (item === null || item === undefined) return null;
      if (typeof item === 'object' && item !== null && 'type' in item && 'data' in item) {
        const child = item as Node;
        return executeSelections(ctx, child, selection.selections);
      }
      return item;
    };
    void childType;
    out[key] = Array.isArray(value) ? value.map(render) : render(value);
  }
  return out;
}

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** Execute one GraphQL document against the store. */
export function executeGraphQL(store: ForgeStore, request: GraphQLRequest): { data?: unknown; errors?: Array<{ message: string }> } {
  let document: Document;
  try {
    document = new Parser(request.query ?? '').parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'no operation in document' }] };
  const operation =
    document.operations.find((op) => request.operationName && op.name === request.operationName) ?? document.operations[0];
  const ctx: ExecContext = {
    store,
    variables: request.variables ?? {},
    fragments: document.fragments,
    errors: [],
  };
  const root: Node = { type: operation.type === 'mutation' ? 'Mutation' : 'Query', data: {} };
  const data = executeSelections(ctx, root, operation.selections);
  const result: { data?: unknown; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}
