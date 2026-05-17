# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](http://keepachangelog.com/)
and this project adheres to [Semantic Versioning](http://semver.org/).

## 1.5.4 - 2026-05-17

### Fixed

- Truncate oversized `get-tab-web-content` responses before sending them over WebSocket to reduce crashes on heavy DOM pages. ([eyalzh/browser-control-mcp#54](https://github.com/eyalzh/browser-control-mcp/issues/54))

## 1.5.3 - 2026-05-17

### Fixed

- Bind the WebSocket server to both `127.0.0.1` and `::1` outside containers so Firefox can connect regardless of IPv4/IPv6 localhost resolution order. ([#51](https://github.com/eyalzh/browser-control-mcp/issues/51))

## 1.5.2 - 2026-05-17

### Changed

- Package Firefox extension builds as versioned `.xpi` artifacts during `npm run build`.
- Add a stable Firefox extension ID for persistent add-on identity.

### Fixed

- Wait for extension WebSocket readiness before sending browser commands to reduce startup reconnect races. ([#32](https://github.com/eyalzh/browser-control-mcp/issues/32)) ([#37](https://github.com/eyalzh/browser-control-mcp/issues/37))
- Increase extension response timeout and include correlation/resource details in timeout errors.
- Ignore late or orphaned extension responses instead of throwing when requests have already timed out.
- Add opt-in server trace logging with `BROWSER_MCP_DEBUG` and extension-side reconnect diagnostics.
