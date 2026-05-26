# ccmobile

> Claude Code in your browser — self-hosted, mobile-friendly, open-source.

ccmobile gives you a browser-based chat interface for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI. Run it on your server or local machine, then access your AI coding assistant from any device — including your phone.

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url> ccmobile
cd ccmobile
npm install

# 2. Start the server
npm start

# 3. Open your browser
# → http://localhost:6767
# A setup wizard will guide you through initial configuration.
```

That's it. The setup wizard in the browser will ask for your projects directory and optionally set an access key.

### Prerequisites

- **Node.js 18+**
- **Claude Code CLI** — installed and authenticated
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude  # follow the auth prompt
  ```
- **Linux** recommended. macOS works but without sandbox isolation (bwrap not available). On Linux, install bubblewrap for process sandboxing:
  ```bash
  sudo apt-get install bubblewrap  # Debian/Ubuntu
  ```

## Features

- **Chat with Claude Code** — real-time streaming responses via SSE
- **Session management** — create, resume, rename, delete conversations
- **Rewind** — restore your code to any previous state (uses Claude's file-history-snapshot)
- **Git integration** — commit & push from the UI
- **File tree** — browse and upload files within projects
- **CLAUDE.md editor** — preview and edit project instructions
- **Ideas panel** — quick notes per project
- **Dark/light theme**
- **Mobile-friendly** — designed to work well on phone screens
- **Sandbox isolation** — each Claude session runs inside bubblewrap (Linux)
- **Optional access key** — protect the UI when exposed to a network

## Configuration

Most configuration can be done from the browser setup wizard on first run. For advanced options, create a `.env` file:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `6767` | Server port |
| `CCMOBILE_PROJECT_ROOT` | `~/projects` | Directory containing your projects |
| `CCMOBILE_ACCESS_KEY` | *(empty)* | Access key to protect the UI (optional) |
| `CCMOBILE_SANDBOX` | `auto` | Sandbox mode: `auto`, `true`, or `false` |
| `CCMOBILE_CLAUDE_CLI` | *(auto-detect)* | Path to Claude CLI binary |
| `CCMOBILE_BWRAP_PATH` | *(auto-detect)* | Path to bwrap binary |
| `CCMOBILE_HOME_DIR` | OS home dir | Home directory for ~/.claude/ paths |

## How It Works

```
Browser  ←→  Express server  ←→  Claude Code CLI (in bwrap sandbox)
  (SPA)        (SSE stream)         (per-project session)
```

1. You select a project and type a message in the browser
2. The server spawns Claude Code CLI with `--output-format stream-json`
3. Claude's response streams back to the browser via Server-Sent Events
4. Sessions are stored in `~/.claude/projects/` (Claude's native format)

Each project is a subdirectory under your configured `CCMOBILE_PROJECT_ROOT`. Just put your code there and it shows up in the UI.

## Security

- **Sandbox isolation** (Linux): Each Claude session runs inside a [bubblewrap](https://github.com/containers/bubblewrap) sandbox. The sandbox only exposes the current project directory (read-write) and system toolchain (read-only). Other projects, SSH keys, and server configs are invisible.
- **No sandbox** (macOS / `CCMOBILE_SANDBOX=false`): Claude runs directly. Use this only on trusted local machines.
- **Access key**: Set `CCMOBILE_ACCESS_KEY` to require authentication. Without it, anyone who can reach the port can use the app.

## Project Structure

```
ccmobile/
├── server.js              # Express backend
├── config.js              # Configuration loader
├── application/
│   └── public/
│       └── index.html     # Frontend SPA (single file, no build step)
├── data/                  # SQLite DB (auto-created, gitignored)
├── .env.example           # Configuration template
├── package.json
└── README.md
```

## License

MIT
