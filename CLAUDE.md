# ccmobile

## Overview
ccmobile — a self-hosted web UI for Claude Code CLI. Access Claude Code from any browser, including mobile. Single-user, open-source, designed for developers who want a browser-based Claude Code experience on their own server or local machine.

## Project Structure
```
ccmobile/
├── server.js                        # Backend (Express, port 6767)
├── config.js                        # Configuration loader (.env)
├── .env.example                     # Configuration template
├── package.json
├── application/
│   └── public/
│       └── index.html               # Frontend SPA (single file)
├── data/
│   └── ccmobile.db                   # SQLite database (auto-created)
```

## Tech Stack
- Single-file Node.js server (Express)
- Frontend: vanilla JS SPA, no build tools
- SQLite (better-sqlite3, WAL mode) for session names and notes
- SSE (Server-Sent Events) for real-time Claude response streaming
- Claude CLI invoked via `child_process.spawn` inside bubblewrap sandbox
- All configuration via `.env` file (see `.env.example`)

## Features
- Chat with Claude Code via browser (mobile-friendly)
- Project selection — each subdirectory under PROJECT_ROOT is a project
- Session management — create, resume, rename, delete conversations
- Rewind — restore code to any previous state using Claude's file-history-snapshot
- Git commit & push from the UI
- File tree browsing and upload
- CLAUDE.md editor (preview + edit)
- Ideas/Notes panel per project
- Dark/light theme
- First-run setup wizard in browser (no manual .env editing needed)
- Optional access key authentication
- bwrap sandbox isolation (auto-detected, optional — works without it too)

## Security
- bwrap sandbox auto-detected: enabled on Linux with bubblewrap, disabled on macOS
- When enabled, sandbox exposes only: project directory (read-write), system toolchain (read-only), Claude runtime
- Optional access key protects the web UI

## Dev Notes
- Frontend is `application/public/index.html` (single-file SPA)
- Backend is `server.js`, config in `config.js`
- Database auto-creates at `data/ccmobile.db`
- All sensitive config via `.env` (never committed)
