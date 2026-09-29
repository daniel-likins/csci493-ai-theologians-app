# Theologians

Theologians is a local-first AI workspace for asking Augustine, Thomas Aquinas, and Martin Luther the same question and comparing their answers side by side. The voices are AI interpretations based on study notes—not the historical people themselves.

This repository is a classroom template with the complete editable React frontend, TypeScript backend, shared definitions, default theologian profiles, and provider presets. The built web interface is also included so a fresh clone can run immediately. It does **not** include anyone's conversations, files, credentials, tokens, usage history, or local database.

## Requirements

- macOS, Windows 10/11, or a modern desktop Linux distribution
- Node.js 24 or newer
- npm
- An API key, local model server, or institutional ALCF access

Linux also needs an unlocked Secret Service keyring and the `secret-tool` command to save API keys. Install Bubblewrap (`bwrap`) to enable the optional shell-command tool. For example, on Ubuntu/Debian:

```bash
sudo apt install libsecret-tools bubblewrap
```

## Run locally

```bash
git clone https://github.com/daniel-likins/csci493-ai-theologians-app.git
cd csci493-ai-theologians-app
npm ci
npm start
```

Open the local URL printed in your terminal. The service binds only to `127.0.0.1`; it is not exposed to the network.

On macOS or Linux, choose a port explicitly with:

```bash
THEO_PORT=47831 npm start
```

In Windows PowerShell:

```powershell
$env:THEO_PORT = "47831"
npm start
```

Press `Ctrl+C` to stop the service.

## Change the interface

The frontend lives in `web/src/` (pages, components, settings, and styles). `web/index.html` and `web/vite.config.ts` define its entry point and build. To rebuild the interface after editing it:

```bash
npm run build
npm start
```

For frontend hot reload, run `npm run dev` and open `http://127.0.0.1:5183`. Restart that command after changing backend files. Development uses a separate `.dev-data/` folder and backend port 47832, so it does not change your normal chats or model connections. On first use, add your own model connection in the development UI.

Before sharing a change, run:

```bash
npm run typecheck
npm test
npm run build
```

`npm run test:e2e` runs the browser tests with a temporary database and a local fake model endpoint. It requires a local Chrome installation. Commit changes in `web/src/` together with the rebuilt `web/dist/` files so classmates who run `npm start` see the same interface.

## Personal data and credentials

Each user gets a separate data folder in the operating system's standard application-data location:

```text
macOS:   ~/Library/Application Support/Theologians Workspace
Windows: %APPDATA%\Theologians Workspace
Linux:   $XDG_DATA_HOME/theologians (or ~/.local/share/theologians)
```

API keys and tokens use that user's native secure storage:

- macOS Keychain
- Windows Data Protection API (DPAPI), with only encrypted blobs kept in the app-data folder
- Linux Secret Service, through `secret-tool` (for example GNOME Keyring or KWallet)

Credentials are not stored in this repository, the SQLite database, exports, or logs.

## Tools on each platform

Chat, model connections, ALCF authentication, backups, and approved file tools work on all three supported operating systems. Native folder/file pickers and “reveal in file manager” use Finder on macOS, Explorer on Windows, and Zenity or KDialog plus `xdg-open` on Linux.

The optional shell-command tool has stricter requirements because model-proposed commands must never run without an OS sandbox:

- macOS uses `sandbox-exec`.
- Linux uses Bubblewrap (`bwrap`). Commands are disabled if it is unavailable.
- Windows keeps shell-command execution disabled because Windows does not include a directly equivalent sandbox. Chat and approved file read/edit tools remain available.

## Connect a model

After starting the app:

1. Open **Settings → Models**.
2. Choose **Add connection**.
3. Pick OpenAI, Anthropic, Gemini, ALCF, Ollama, LM Studio, or a compatible custom endpoint.
4. Add and enable at least one model.
5. Return to the Round Table and select it from the model picker.

### ALCF

ALCF users should follow the [official inference endpoint guide](https://docs.alcf.anl.gov/services/inference-endpoints/). Authenticate once with ALCF's `inference_auth_token.py` helper, then configure Theologians' token command with one argument per line. Use the full Python executable path for your operating system:

```text
/full/path/to/python3
/full/path/to/inference_auth_token.py
get_access_token
```

On Windows, those paths will typically resemble `C:\Users\you\...\python.exe` and `C:\Users\you\...\inference_auth_token.py`.

ALCF access is individual. Each classmate must authenticate with their own authorized account.

## Repository contents

- `server/src/` — local API, model providers, database, backups, memory, and tools
- `server/defaults/` — theologian workspaces, assistant profiles, and provider presets
- `shared/` — shared application types and constants
- `web/src/` — editable React frontend
- `web/dist/` — generated frontend served by the backend
- `server/test/` and `e2e/` — backend and browser regression tests
- `scripts/` — portable development and stop commands

## Desktop wrapper

The shared classroom build runs in a browser on macOS, Windows, and Linux. The original macOS desktop wrapper is not part of this cross-platform template; it is not required to run or develop the app.
