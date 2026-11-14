# github-core-clone-01 — a GitHub-compatible forge (w2 variant)

A single-process, dependency-free GitHub-compatible git forge written in
TypeScript for Node 22's type stripping. It serves four surfaces from one
shared in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — a real git object store
  implemented from scratch (SHA-1 objects, packfiles with delta
  resolution, protocol v2 `ls-refs`/`fetch` with shallow support, a v0
  upload-pack fallback, and v0 receive-pack with per-ref report-status).
- **REST v3** under `/api/v3` — repositories, branches, commits, the
  contents API, labels, issues, comments and pull requests (including
  squash merges with three-way conflict detection).
- **GraphQL v4** at `/api/graphql` — viewer/repository reads, issue and
  pull-request connections with cursor paging, `node(id:)`, the
  introspection probes gh feature-detects on, and the
  createIssue / closeIssue / createPullRequest / mergePullRequest /
  addComment mutations.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP with
  `server/discover`, the initialize handshake, and six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store
  as REST.

## Layout

The design is deliberately modular, one responsibility per file:

| file          | role                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `main.ts`     | thin bootstrap: bind port 0, register with the env, poll `/done`     |
| `app.ts`      | HTTP dispatcher: auth, body handling, surface routing                |
| `store.ts`    | domain state (`ForgeStore`), JSON views, squash-merge logic          |
| `gitstore.ts` | git object model: `GitStore` class, pkt-lines, pack read/write      |
| `githttp.ts`  | smart HTTP: advertisements, upload-pack, receive-pack                |
| `rest.ts`     | REST v3: an explicit router table plus one handler per route         |
| `graphql.ts`  | GraphQL: a small parser, schema tables and the executor              |
| `mcp.ts`      | MCP: JSON-RPC dispatch and the fixed tool list                       |

Correctness and readability come first: plain classes, a monotone
logical clock instead of wall-clock timestamps, and ids that stay the
same object across every surface.

## Running

The program is started by the make.fun harness with two environment
variables set:

- `MAKEFUN_ENV_URL` — the trial environment's origin; the forge
  registers its ephemeral port there and waits for its done signal.
- `MAKEFUN_SHOP_TOKEN` — the bearer token every API surface requires.

```sh
node main.ts
```

Node 22 or later, standard library only; there is nothing to install.
