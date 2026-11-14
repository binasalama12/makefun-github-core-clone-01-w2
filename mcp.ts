// mcp.ts — the Model Context Protocol endpoint: JSON-RPC 2.0 over
// Streamable HTTP. It supports the modern server/discover revision
// (2026-07-28, plus the 2025-11-25 handshake era for initialize clients)
// and a fixed tool list. The tools act on the same ForgeStore as REST,
// so ids and numbers are identical across surfaces.
//
// The tool definitions are built exactly once, as a constant, so two
// tools/list answers serialize byte-for-byte identically.

import {
  ForgeStore,
  OWNER_LOGIN,
  issueView,
  pullView,
  repoView,
  squashMerge,
  type RepoRec,
} from './store.ts';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });
const num = (description: string): { type: string; description: string } => ({ type: 'number', description });
const bool = (description: string): { type: string; description: string } => ({ type: 'boolean', description });

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The repository name.'),
        description: str('A short description of the repository.'),
        private: bool('Whether the repository is private.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: str('The repository owner login.'), repo: str('The repository name.') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The issue title.'),
        body: str('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        state: str('Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The pull request title.'),
        head: str('The head branch name.'),
        base: str('The base branch name.'),
        body: str('The pull request body.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number, using a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        pull_number: num('The pull request number.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const PREFERRED_VERSION = '2025-11-25';

export interface RpcReply {
  status: number;
  payload: Record<string, unknown> | null; // null => no body (notifications)
}

function rpcResult(id: unknown, result: unknown): RpcReply {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}
function rpcError(id: unknown, code: number, message: string, status = 200): RpcReply {
  return { status, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}
function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const out: Record<string, unknown> = { content: [{ type: 'text', text }], isError };
  if (typeof value === 'object' && value !== null) out.structuredContent = value;
  return out;
}
function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoArg(store: ForgeStore, args: Record<string, unknown>): RepoRec | null {
  const owner = typeof args.owner === 'string' ? args.owner : OWNER_LOGIN;
  let name = typeof args.repo === 'string' ? args.repo : '';
  if (name === '' && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    name = parts[parts.length - 1];
  }
  if (name.includes('/')) name = name.split('/').pop() as string;
  return store.getRepo(owner, name);
}

function callTool(store: ForgeStore, name: string, rawArgs: unknown): Record<string, unknown> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new ToolNotFound(name);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolFailure(`missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = store.getRepo(OWNER_LOGIN, repoName);
      if (existing) return toolResult(repoView(existing));
      const repo = store.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === undefined ? false : Boolean(args.private),
      );
      if (!repo) return toolFailure('repository already exists');
      return toolResult(repoView(repo));
    }
    case 'get_repo': {
      const repo = repoArg(store, args);
      return repo ? toolResult(repoView(repo)) : toolFailure('repository not found');
    }
    case 'create_issue': {
      const repo = repoArg(store, args);
      if (!repo) return toolFailure('repository not found');
      const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return toolResult(issueView(repo, issue));
    }
    case 'list_issues': {
      const repo = repoArg(store, args);
      if (!repo) return toolFailure('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return toolResult(issues.map((issue) => issueView(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoArg(store, args);
      if (!repo) return toolFailure('repository not found');
      const head = String(args.head);
      const base = String(args.base);
      if (!repo.git.refs.has(`refs/heads/${head}`)) return toolFailure(`head branch "${head}" does not exist`);
      if (!repo.git.refs.has(`refs/heads/${base}`)) return toolFailure(`base branch "${base}" does not exist`);
      const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      return toolResult(pullView(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoArg(store, args);
      if (!repo) return toolFailure('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return toolFailure('pull request not found');
      if (pull.state !== 'open') return toolFailure('pull request is not open');
      const outcome = squashMerge(store, repo, pull);
      if (!outcome.ok) return toolFailure('pull request is not mergeable');
      return toolResult({ ...pullView(repo, pull), sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    }
  }
  return toolFailure('unhandled tool');
}

class ToolNotFound extends Error {
  constructor(name: string) {
    super(`unknown tool: ${name}`);
  }
}

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };

/** Handle one JSON-RPC request object already parsed from the body. */
export function handleRpc(store: ForgeStore, request: Record<string, unknown>): RpcReply {
  const id = 'id' in request ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;
  const isNotification = !('id' in request);
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : PREFERRED_VERSION;
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { status: 202, payload: null };
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      try {
        const result = callTool(store, name, params.arguments ?? {});
        return rpcResult(id, result);
      } catch (err) {
        if (err instanceof ToolNotFound) return rpcError(id, -32602, err.message);
        return rpcError(id, -32602, err instanceof Error ? err.message : 'tool call failed');
      }
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      if (isNotification) return { status: 202, payload: null };
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
