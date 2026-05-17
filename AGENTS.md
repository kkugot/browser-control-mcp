# AGENTS.md

Guidance for agentic coding assistants operating in this repository.

## Repo Snapshot

- Monorepo with three TypeScript projects:
  - `mcp-server` (Node MCP server over stdio + WebSocket)
  - `firefox-extension` (Firefox WebExtension)
  - `common` (shared message types/interfaces)
- Primary runtime path:
  - MCP client <-> `mcp-server` (stdio)
  - `mcp-server` <-> extension (WebSocket + shared secret)
- Security model is intentional and must be preserved:
  - Extension permissions are explicit and user-mediated.
  - Domain deny list and command enable/disable controls exist.
  - Shared-secret message signing is required for server/extension traffic.

## Environment & Tooling

- Node: `>=22.0.0` required for `mcp-server`.
- Package manager: npm (lockfile is `package-lock.json`).
- Build orchestration: Nx from root.
- Extension build bundler: esbuild.
- Tests: Jest (`ts-jest`, `jsdom`) in `firefox-extension`.
- TypeScript config is strict in both server and extension.

## Install

- Install root + subproject deps:

```bash
npm install
```

Notes:
- Root `postinstall` installs both `mcp-server` and `firefox-extension` deps.

## Build Commands

- Build all projects (preferred):

```bash
npm run build
```

- Equivalent explicit Nx command:

```bash
npx nx run-many --target=build --all --parallel
```

- Build MCP server only:

```bash
cd mcp-server && npm run build
```

- Build Firefox extension only:

```bash
cd firefox-extension && npm run build
```

## Test Commands

- Run all extension tests:

```bash
cd firefox-extension && npm test
```

- Run a single test file (most common focused run):

```bash
cd firefox-extension && npm test -- __tests__/message-handler.test.ts
```

- Run one test case by name pattern:

```bash
cd firefox-extension && npm test -- -t "should open a new tab and send the tab ID to the server"
```

- Run in watch mode while iterating:

```bash
cd firefox-extension && npm test -- --watch
```

Notes:
- `jest.config.js` uses `testMatch: ['**/__tests__/**/*.test.ts']`.
- There are currently extension unit tests; no separate root test runner is defined.

## Lint / Format / Typecheck

- No dedicated lint script/config is currently present (no ESLint config detected).
- No dedicated formatter config is currently present (no Prettier config detected).
- Treat TypeScript compile as the main static gate:
  - Root: `npm run build`
  - Per-project: `npm run build` in each package.

## Run Commands (Local)

- Start built MCP server:

```bash
cd mcp-server && npm start
```

- Package MCP server DXT:

```bash
cd mcp-server && npm run pack-dxt
```

## Architecture-Sensitive Change Rules

- Keep protocol changes synchronized across all three areas:
  - `common/*-messages.ts`
  - `mcp-server/*` (request/response handling)
  - `firefox-extension/*` (message handling and tests)
- If you add/rename a command:
  - Update union types in `common`.
  - Update extension switch handling and permission mapping.
  - Update MCP tool surface and any related descriptions.
  - Update/add tests in `firefox-extension/__tests__`.

## Code Style Guidelines

### TypeScript & Types

- Keep `strict` TypeScript compatibility.
- Prefer explicit interfaces/types for message payloads and config objects.
- Use discriminated unions for command/resource variants.
- Use exhaustive `switch` checks (`never`) for union handling.
- Avoid `any`; if unavoidable, isolate and narrow quickly.
- Prefer `import type` for type-only imports.

### Imports

- Group imports in this order:
  1. External packages
  2. Internal/shared package imports (`@browser-control-mcp/common`)
  3. Relative local imports
- Keep import paths stable and explicit; do not introduce deep fragile aliases.

### Naming

- `PascalCase`: classes, interfaces, type aliases.
- `camelCase`: functions, methods, variables, parameters.
- `UPPER_SNAKE_CASE`: true constants (timeouts, defaults, limits).
- Use descriptive names for message resources and command IDs.
- Preserve existing wire command strings (kebab-case literals like `open-tab`).

### Formatting

- Follow existing file-local style and keep diffs minimal.
- Use semicolons consistently.
- Prefer double quotes where already dominant in touched files.
- Keep lines readable; wrap long literals where practical.
- Do not introduce broad formatting-only churn.

### Error Handling & Logging

- Fail fast on required startup config (for example missing `EXTENSION_SECRET`).
- Throw `Error` with actionable, user-meaningful messages.
- Log with context (`console.error("context", error)`).
- Do not swallow errors silently; propagate or return structured error responses.
- Keep timeout/error paths deterministic (cleanup pending request maps, etc.).

### Async, Concurrency, and State

- Prefer `async/await` over chained promises.
- Await asynchronous side effects that matter to correctness.
- Guard stateful maps/connection state before use.
- Keep request/response correlation IDs unique and scoped.

### Validation & Security

- Validate external/tool inputs at boundaries (server uses `zod`).
- Enforce HTTPS/domain checks and permission checks in extension flows.
- Preserve shared-secret signing/verification behavior.
- Keep privacy posture: avoid adding unnecessary data collection/logging.

### Testing Expectations

- Update or add Jest tests for behavior changes in extension logic.
- Mock browser APIs and websocket client interactions deterministically.
- Assert both success and failure/permission-denied paths.
- Prefer descriptive test names (`should ...`) and clear Arrange/Act/Assert flow.

## Agent Workflow Recommendations

- Before editing, scan neighboring files and mirror established conventions.
- For non-trivial changes, run focused tests first, then broader build.
- When touching message contracts, verify all cross-package compile points.
- Keep commits small and cohesive when asked to commit.

## Rules File Status

- Cursor rules:
  - No `.cursorrules` file found.
  - No `.cursor/rules/` directory found.
- Copilot instructions:
  - No `.github/copilot-instructions.md` file found.

If these rule files are added later, treat them as higher-priority local guidance
and update this document accordingly.
