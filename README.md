<div align="center">

<h1><img src="assets/janus-logo.svg" alt="JanusAPI" height="64"></h1>

**The open-source API client with an AI agent that works on your requests, with your own model or a local one.**

Build, send and test HTTP and GraphQL requests. Ask Janus why a request fails and it reads the response, fixes the request and writes the tests, asking you before it sends anything.

[![License: MIT](https://img.shields.io/badge/license-MIT-3DF5B0)](LICENSE) [![CI](https://github.com/mehtastack/JanusAPI/actions/workflows/ci.yml/badge.svg)](https://github.com/mehtastack/JanusAPI/actions/workflows/ci.yml) [![Downloads](https://img.shields.io/github/downloads/mehtastack/JanusAPI/total?color=3DF5B0)](https://github.com/mehtastack/JanusAPI/releases) ![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-555) ![No account](https://img.shields.io/badge/account-not%20needed-555)

<p>
<a href="https://github.com/mehtastack/JanusAPI/releases/latest/download/JanusAPI-arm64.dmg"><img src="assets/download/macos.svg" alt="Download for macOS" height="48"></a>
<a href="https://github.com/mehtastack/JanusAPI/releases/latest/download/JanusAPI-Setup-x64.exe"><img src="assets/download/windows.svg" alt="Download for Windows" height="48"></a>
<a href="https://github.com/mehtastack/JanusAPI/releases/latest/download/JanusAPI-x86_64.AppImage"><img src="assets/download/linux.svg" alt="Download for Linux" height="48"></a>
</p>

<sub>macOS button: Apple silicon · also for <a href="https://github.com/mehtastack/JanusAPI/releases/latest/download/JanusAPI-x64.dmg">Intel Macs</a> · Linux as <a href="https://github.com/mehtastack/JanusAPI/releases/latest/download/janusapi_amd64.deb">.deb</a> · <a href="https://github.com/mehtastack/JanusAPI/releases">all releases</a></sub>

<sub>Downloaded builds are not signed yet, so macOS and Windows ask once before the first open (<a href="#install">how</a>). Or <a href="#install-from-source-one-command">install from source with one command</a>, which never asks.</sub>

[Website](https://mehtastack.com/janusapi) · [All releases](https://github.com/mehtastack/JanusAPI/releases) · [Why JanusAPI](#janusapi-vs-postman-vs-bruno)

<img src="assets/janus-demo.svg" alt="Animated: a request fails with 401, Janus switches the auth to a Bearer token, asks before sending, and the request returns 200 OK" width="640">

</div>

## Why JanusAPI

JanusAPI is built around **Janus**, an AI agent that works directly on your requests: it reads the response, edits the request, sends it with your approval and writes the tests. Think *Cursor for API development* rather than a chat window. Around it is a full API client that keeps everything as plain files on your disk, with no account.

- **Bring your own model.** Anthropic, any OpenAI-compatible API, or a local model through Ollama. Your keys stay in your system keychain.
- **You stay in control.** Janus's edits show as a draft you can undo, and by default it asks before it sends anything, naming the host.
- **Git-friendly.** Every request is a readable YAML file, so reviews, branches and diffs just work.
- **Open source, MIT licensed.** No sign-in, no seat limits, no AI credits to run out of.

## What you can do

### Fix a failing request by asking why

Send a request, get a 401, ask *"Why do I get a 401?"*. Janus reads the request and the response, proposes the change (here: the API wants a Bearer token, not an `X-Api-Key` header) and asks before sending it again. Every field it touched glows with a **Janus** badge until you save.

<img src="assets/screenshots/janus-approval.png" alt="Janus asking for approval before sending the edited request to 127.0.0.1" width="100%">

<img src="assets/screenshots/janus-fix.png" alt="Janus fixed the request: it switched the auth to a Bearer token and the request now returns 200 OK" width="100%">

### Let Janus write the tests

Ask for tests and Janus writes them against the real response, runs them, and reports back. They are ordinary test scripts in the request file.

<img src="assets/screenshots/janus-tests.png" alt="Janus added two tests; the Tests tab shows three passing tests" width="100%">

### Run a folder and let Janus fix what fails

Ask *"Run the auth folder and fix what fails"*. Janus runs the requests on the real runner (you approve each run and see every host it will reach), groups the failures by cause, fixes the affected requests as drafts, re-runs only the failures, and leaves a triage card in the chat. The Runner shows each failure's cause and its before → after.

<img src="assets/screenshots/triage.png" alt="Janus's triage card: one cause, fixed, 1 failed → 0 failed" width="100%">

### Send, inspect and filter responses

Params, headers, bodies (JSON, form, multipart, binary, XML, raw), `{{variables}}` resolved from environments, and a response view with folding, search and JSONPath filtering. HTML and images preview in a locked-down sandbox.

<img src="assets/screenshots/workbench.png" alt="A GET request with query params and a 200 OK JSON response filtered with $.items[0:2]" width="100%">

### Every common auth scheme

Bearer, Basic, API key (header or query), JWT (signed for you), OAuth 2.0 (client credentials, password and authorization code), Digest and AWS Signature v4. Set auth once on a folder or the collection and let requests inherit it.

<img src="assets/screenshots/auth.png" alt="The Auth tab set to AWS Signature with access key, secret key, region and service fields" width="100%">

### Jump to any request

Press <kbd>⌘P</kbd> / <kbd>Ctrl+P</kbd> and type: name, method, path or folder. Or describe the request in plain words and hand the search to Janus.

<img src="assets/screenshots/find.png" alt="The Find request palette showing two upload requests for the query 'upload'" width="100%">

### Run whole collections

Run a folder or the whole collection in order, with pre-request scripts, tests, iterations, delays and a CSV or JSON data file (one iteration per row).

<img src="assets/screenshots/runner.png" alt="The runner showing every request of the demo collection passed, with status, time and test counts" width="100%">

### Copy the request as code

Any request as cURL (POSIX or Windows), `fetch`, axios, Python, Go, HTTPie or PowerShell, with secrets hidden by default.

<img src="assets/screenshots/code-snippets.png" alt="The Code dialog showing a request as Python" width="100%">

### History you can trust

Every send is recorded per collection with secrets masked. Search it, copy an entry as cURL, or restore it as a draft.

<img src="assets/screenshots/history.png" alt="The history view listing sends with method, URL, status and time, and one entry's redacted headers" width="100%">

### GraphQL (preview)

Queries and mutations with variables, schema fetch or import, docs and autocomplete. GraphQL is in preview: start the app with `APIJANUS_FEATURE_GRAPHQL=1` to turn it on.

<img src="assets/screenshots/graphql.png" alt="A GraphQL query with variables and its JSON response" width="100%">

### Your model, your settings

Pick Anthropic, an OpenAI-compatible endpoint or a local Ollama model. Proxy (system, PAC or manual), extra trusted CAs, client certificates (mTLS) and cookies are all in Settings.

<img src="assets/screenshots/settings.png" alt="Settings with Ollama selected as the AI provider, the model llama3.1, and 'Ask before sending requests' checked" width="100%">

<sub>The Janus conversations in these screenshots are scripted so they can be reproduced; the app around them is real. Screenshots are taken by `apps/desktop/demo-video/screenshots.spec.ts`.</sub>

## Everything else

| | |
|---|---|
| **Import** | Postman collections (with their scripts and auth), OpenAPI 3, Swagger 2.0 and cURL commands, from a file, a URL or a paste |
| **Postman scripts** | The `pm` API most scripts use (`pm.environment`, `pm.test`, `pm.expect`, `pm.response.to…`, `pm.iterationData`, `pm.cookies`) runs mostly unchanged |
| **Scripts** | Pre-request and test scripts on the collection, folders and requests, in a sandbox with no network, file system or timers, and time and memory limits |
| **Environments** | Plain values saved in the collection, secret values in the OS keychain |
| **Cookies** | A cookie jar per collection, sent and stored like a browser would |
| **File uploads** | Multipart and binary bodies; files outside the collection are sent only after you choose them on this computer |
| **Network** | System, PAC or manual proxy, extra CA certificates, OS root store, client certificates (PEM or PKCS#12) |
| **Themes** | Dark and light, following the OS by default |
| **Updates** | The app checks GitHub Releases and installs updates itself where the platform allows |

## Command line

Run a collection in CI with the same engine as the app: same order, scripts, tests and auth.

```sh
janus run ./my-collection -e Staging -r cli,junit -o ./reports
```

```text
JanusAPI Demo · env Staging · 1 iteration

PASS  GET    users/List <users> & "friends"  200  12 ms  tests 1/1
FAIL  POST   users/Create  201  30 ms  tests 0/1
     ✗ has id: expected undefined to exist
ERR   GET    auth/basic/Me  —
     secret variable `token` has no value — pass --var token=… or set JANUS_VAR_token
SKIP  GET    Later  —

1 passed, 1 failed, 1 errored, 1 skipped in 1.2 s
```

Data files (`-d data.csv`), iterations, `--bail`, proxies and client certificates are supported; reporters are `cli`, `json` and `junit`. Exit codes: `0` all passed, `1` a request failed, `2` setup problem, `130` interrupted. The CLI is built from source for now (see below).

## JanusAPI vs Postman vs Bruno

Postman and Bruno are both good tools. Here is where JanusAPI differs, including where it is behind.

| | **JanusAPI** | Postman | Bruno |
|---|:---:|:---:|:---:|
| Open source | ✅ MIT | ❌ Proprietary <sup>1</sup> | ✅ MIT <sup>2</sup> |
| Works without an account | ✅ | ⚠️ Basic client only; collections need sign-in | ✅ |
| Local-only, no cloud sync | ✅ | ❌ Cloud workspaces | ✅ |
| Collections as plain files for Git | ✅ YAML | ✅ YAML, through Native Git | ✅ YAML or `.bru` |
| Built-in Git UI (commit, branches) | ❌ Use your own Git tools | ✅ | 💲 Basic on free; commit and branches on paid plans |
| AI agent that edits **and sends** requests | ✅ Janus | ✅ Agent Mode | ❌ Bruno AI writes scripts, tests and docs |
| AI runs a folder or collection and fixes what fails | ✅ Free, with your own or a local model | 💲 Agent Mode, on AI credits | ❌ |
| AI asks before every send or run, naming every host | ✅ On by default; run cards also list file uploads | ⚠️ Approval for state-changing actions; can auto-run | — |
| Bring your own AI key | ✅ Anthropic, OpenAI-compatible | ❌ Not documented | ✅ |
| Local model (Ollama) | ✅ | ❌ Not documented | ✅ Through an OpenAI-compatible endpoint |
| AI usage limits | Only your provider's | 💲 50 credits a month free, more on paid plans | Only your provider's |
| Runs Postman `pm.*` scripts | ✅ Mostly unchanged | ✅ Native | ⚠️ Translated to `bru.*` on import |
| Collection runner | ✅ | ✅ | ✅ |
| Data-driven runs (CSV/JSON) in the app | ✅ Free | 💲 Paid plans | 💲 Paid plans (free in the CLI) |
| CLI with JUnit/JSON reports | ✅ | ✅ | ✅ |
| JWT generation | ✅ | ✅ | ❌ |
| OAuth 2.0, Digest, AWS Signature v4 | ✅ | ✅ | ✅ |
| GraphQL with schema and autocomplete | ⚠️ Preview | ✅ | ✅ |
| WebSocket, gRPC and other protocols | ❌ HTTP and GraphQL only | ✅ | ✅ |
| Web version | ❌ | ✅ | ❌ |
| Price | Free | Free; Solo $9/mo, Team $19/user/mo | Free; Pro $6/user/mo, Ultimate $11/user/mo |

<sub>✅ yes · ⚠️ partly · 💲 on a paid plan · ❌ no. Checked against each product's website, pricing and documentation on 12 October 2026; prices are billed yearly. Features change, so check [Postman's pricing](https://www.postman.com/pricing/) and [Bruno's pricing](https://www.usebruno.com/pricing) for the latest. <sup>1</sup> Postman's Newman runner is open source (Apache 2.0). <sup>2</sup> Bruno also sells Pro and Ultimate editions. Postman and Bruno are trademarks of their owners; JanusAPI is not affiliated with either.</sub>

## Install

JanusAPI runs on **macOS** (Apple silicon and Intel), **Windows** (x64) and **Linux** (x64). Download the latest version:

| Platform | Download |
|---|---|
| macOS, Apple silicon | [JanusAPI-arm64.dmg](https://github.com/mehtastack/JanusAPI/releases/latest/download/JanusAPI-arm64.dmg) |
| macOS, Intel | [JanusAPI-x64.dmg](https://github.com/mehtastack/JanusAPI/releases/latest/download/JanusAPI-x64.dmg) |
| Windows, x64 | [JanusAPI-Setup-x64.exe](https://github.com/mehtastack/JanusAPI/releases/latest/download/JanusAPI-Setup-x64.exe) |
| Linux, x64 | [JanusAPI-x86_64.AppImage](https://github.com/mehtastack/JanusAPI/releases/latest/download/JanusAPI-x86_64.AppImage) (`chmod +x` it, then run it) |
| Debian and Ubuntu, x64 | [janusapi_amd64.deb](https://github.com/mehtastack/JanusAPI/releases/latest/download/janusapi_amd64.deb) (`sudo apt install ./janusapi_amd64.deb`) |

Every release is on the [Releases](https://github.com/mehtastack/JanusAPI/releases) page. The app checks for new releases and shows them in **Settings → About**; signed macOS, Windows and AppImage builds update themselves.

### Install from source (one command)

Build JanusAPI on your own machine and install it, with Node.js 22 or later and Git. An app you build yourself opens without the macOS or Windows warning.

```sh
git clone https://github.com/mehtastack/JanusAPI.git && cd JanusAPI && npm run install:app
```

- **macOS**: installs `JanusAPI.app` in `/Applications`.
- **Windows**: runs the installer for your user, with Start menu and desktop shortcuts.
- **Linux**: installs to `~/.local/share/janusapi`, with a `janusapi` command and an app-menu entry. On Ubuntu 24.04 and later it asks for your password once, to set up Chromium's sandbox helper.

Add `--cli` to also install the `janus` command-line runner (`npm run install:app -- --cli`), or `--no-app` for the command only. To update: `git pull && npm run install:app`.

### First open of a downloaded build

The downloads are not signed yet. On **macOS**, open the app once, then choose **Open Anyway** in System Settings → Privacy & Security (or run `xattr -dr com.apple.quarantine /Applications/JanusAPI.app`). On **Windows**, SmartScreen warns: choose **More info → Run anyway**.

## Contributing

Issues and pull requests are welcome. Run the checks before opening a PR:

```sh
npx -y pnpm@10 -r typecheck
npx -y pnpm@10 -r test
```

## License

JanusAPI is released under the [MIT License](LICENSE). Project page: [mehtastack.com/janusapi](https://mehtastack.com/janusapi).
