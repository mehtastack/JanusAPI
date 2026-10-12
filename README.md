# JanusAPI

An open-source, AI-native API client: a desktop app for building, sending and testing HTTP and GraphQL requests, with an AI agent that can do the same on your behalf while you stay in control. See [requirement.md](requirement.md) for the product specification.

## Install

JanusAPI is a desktop app for macOS (Apple silicon and Intel), Windows (x64) and Linux (x64). There is no published
release yet. When releases are published they appear on the project's GitHub **Releases** page:

- **macOS**: a `.dmg` per architecture; open it and drag JanusAPI to Applications.
- **Windows**: `JanusAPI-Setup-<version>-x64.exe`. An unsigned installer makes SmartScreen warn on first run: choose
  **More info → Run anyway**.
- **Linux**: an AppImage (`chmod +x` it, then run it) or a `.deb` (`sudo apt install ./janusapi_<version>_amd64.deb`).
  Saving secrets needs a desktop keyring (GNOME Keyring or KWallet); without one JanusAPI shows a banner and keeps
  secrets for the session only.

The app checks for new releases and shows them in **Settings → About**; macOS (signed), Windows and AppImage builds
install updates themselves, the others link to the release page. Until there is a release, build it yourself on the
system you want it for:

```sh
npx -y pnpm@10 install
npx -y pnpm@10 --filter @apijanus/desktop dist
```

The app lands in `apps/desktop/release/`. A macOS build without a Developer ID certificate is unsigned, so macOS blocks
the first open. Try to open it once, then choose **Open Anyway** in System Settings → Privacy & Security (on macOS 14
and earlier, Control-click the app → **Open** also works). If macOS instead says the app is damaged, run
`xattr -dr com.apple.quarantine /Applications/JanusAPI.app`. [docs/releasing.md](docs/releasing.md) covers building,
signing, notarization and cutting a release on each system.

## Scripting

Each request can have a **pre-request script**, which runs before the request is sent, and a **test script**, which runs after the response arrives. The collection and each folder can have them too: edit them with **Collection settings** at the top of the collection tree, or the ⚙ button on a folder's row. They are stored as `script` and `tests` in `apijanus.yml` and in the folder's `folder.yml`. Scripts are JavaScript and run in an isolated sandbox. The sandbox has no network, no file system, no timers and no module loader. Each script has a time limit and a memory limit.

### Order and variable timing

Every send (Send, the runner and Janus) runs these steps:

1. The collection's and folders' headers and auth are merged into the request. `{{variables}}` are **not** resolved yet. Files to upload are checked now, before any script runs (file paths are never templates, and scripts can't add files).
2. The pre-request scripts run in this order: the collection's, then each folder's from the outermost in, then the request's own. Each script sees the request as the script before it left it, and the variables as they are at that point, including any value an earlier script set with `env.set`.
3. `{{variables}}` are resolved in the URL, params, headers, body and auth, using every variable, including the values the scripts just set. So a pre-request script can `env.set('stamp', …)` and the same send uses `{{stamp}}`. Then the request is built: the GraphQL body, the checked files, auth (including JWT and AWS Signature v4 signing) and cookies.
4. The request is sent.
5. The test scripts run in the same order: collection, folders, request. Results from the collection and folders are prefixed with where they come from, for example `[collection] status is 200` or `[folder: auth] has token`.

What a pre-request script sees (a change from earlier versions, where scripts saw the resolved request):

- `req.url` and `pm.request.url` are the **unresolved base URL template**, such as `{{baseUrl}}/users/{{id}}`, without the request's params. The params are kept apart and always appended after the scripts, encoded as for any send, so a script that adds to the URL (`req.url += "?ts=1"`) never loses or splits them. In a URL a script wrote, each `{{variable}}` in the path or query is URL-encoded; one that starts the URL (a base URL) is used as is.
- Header values and the body show their `{{placeholders}}`. A script that parses the body (`JSON.parse(pm.request.body.raw)`) or signs the URL or headers works on the template, not on the bytes that are sent; a body with an unquoted placeholder, like `{"id": {{id}}}`, is not valid JSON there. Use `env.get` to read a value.
- The Content-Type that JanusAPI adds for the body type (`application/json`, the form type, the multipart boundary) is not in `req.headers`: it is added when the request is built, after the scripts. A Content-Type you set yourself is there and is sent. Auth is applied after the scripts too, so its header is not in `req.headers` either.
- A body a script replaces is sent with its `{{variables}}` resolved: form-encoded in a form body, as written in a JSON or text body. A multipart body can't be rewritten by a script (the send stops with "Scripts can't rewrite a multipart body; change its fields in the Body tab"); scripts still see its fields, or its files as `req.files`.

A pre-request script that throws or runs out of time stops the send. The error names its level, for example `Pre-request script (folder auth) failed: …`, and nothing any pre-request script set in that send is kept. Copy as cURL, history's Copy as cURL and the JWT preview never run scripts: they resolve the variables as they stand, so they differ from what was sent when a script set a variable the request uses.

When Janus is involved (a send Janus starts, or any send of a request that carries Janus's unsaved edits), the destination is checked again once the scripts ran and the variables are resolved: the URL's host and the OAuth 2.0 token and authorization hosts. A host that wasn't approved stops the send before any byte goes out, with "The request's host changed to … after its scripts ran; it needs your approval"; the next time Janus sends it, it asks you about that host by name.

In the runner, a request fails when any of its tests fail. When all its tests pass it passes, except that a request with no tests of its own (only collection or folder tests) still fails on a 4xx or 5xx status.

### Built-in API

| Name | What it does |
|---|---|
| `env.get(name)`, `env.set(name, value)` | Read a resolved variable, or set a runtime variable. |
| `req` | The outgoing request: `method`, `url`, `headers` (`[name, value]` pairs), `body` and `setHeader(name, value)`. A pre-request script can change it before the request is sent. For a body that uploads files, `body` is undefined and `req.files` lists each file as `{ name, kind: 'file', fileName, size }`: a script never sees a file's bytes or path. Setting `body` sends that text instead (except for a multipart body; see above). In a pre-request script, `url`, headers and body are templates (see above). |
| `res` | In test scripts only: the response's `status`, `headers`, `body` (parsed JSON when possible) and `time`. |
| `test(name, fn)`, `expect` | Record a test result. `expect` is chai's `expect`. |
| `crypto.randomUUID()` | Return a random UUID. |
| `iteration` | The run iteration, read-only: `index` (1-based in a run; `0` for a single Send or a Janus send), `count` (`1` for a single send) and `data`, the data row's values as strings (`{}` for a single send or a run without a data file). |

### Postman scripts

Collections imported from Postman keep their scripts: request scripts, and the collection's and folders' scripts too. A Postman collection imported as a new collection puts its own scripts and auth in `apijanus.yml`. Imported into a collection you already have (its root or a folder), it goes into a new folder named after it, which takes the Postman collection's scripts and auth, so nothing it brings runs for the requests already there; `apijanus.yml` is never changed. The `pm` API used by most Postman scripts is supported, so these scripts mostly run unchanged:

- `pm.environment`, `pm.variables`, `pm.collectionVariables` and `pm.globals`;
- `pm.request` and `pm.response`, including the `pm.response.to...` assertions;
- `pm.test` and `pm.expect`;
- `pm.info`, including `pm.info.iteration` (0-based, as in Postman: `iteration.index - 1` in a run, `0` for a single send) and `pm.info.iterationCount`;
- `pm.iterationData.get(name)`, `has(name)`, `toObject()` and `replaceIn(text)`, read-only, from the current iteration's data row (see [Data-driven runs](#data-driven-runs));
- `pm.cookies.get(name)`, `pm.cookies.has(name)` and `pm.cookies.toObject()`, read-only (see [Cookies](#cookies));
- the legacy globals `postman.setEnvironmentVariable`, `tests[...]`, `responseBody` and `responseCode`.

Differences from Postman:

- **One variable layer.** JanusAPI has a single layer of runtime variables. All four `pm` variable scopes read the resolved variables, and every `set` writes a runtime variable that later requests in the session can see.
- **`unset` blanks a value; it does not remove it.** `pm.environment.unset('token')` and the other scopes' `unset` set the runtime value to an empty string. The rest of that script treats the variable as absent. Later scripts and later sends see `''`, not the environment's own value.
- **Scripts are synchronous.** These tests fail with an error:
  - async tests;
  - `pm.test(name, function (done) { ... })` callbacks that don't call `done()` before returning.

  `setTimeout`, `setInterval` and `require` are not available, and using one fails the script with a named error.
- **Some features are not supported.** Using any of the following fails the script with `<name> is not supported in JanusAPI scripts`:
  - `pm.sendRequest`;
  - writing cookies: `pm.cookies.set`, `unset`, `clear` and `pm.cookies.jar()`;
  - `pm.vault` and `pm.visualizer`;
  - `pm.execution.setNextRequest` and `postman.setNextRequest`;
  - writing iteration data: `pm.iterationData.set`, `unset` and `clear`;
  - unknown members of `pm.response.to` and `pm.request.url`, such as `pm.request.url.query`.

  You can still check whether an object exists, for example with `typeof pm.vault`.
- **Status reason text.** `pm.response.status` and `pm.response.to.have.status('Not Found')` use the server's reason phrase. If the server sends none, as with HTTP/2, they use the standard phrase for the code.

### Data-driven runs

The Runner can run the selected requests once per row of a data file. In the Runner's **Data** section, choose a CSV or JSON file; the Runner shows its name, row and column counts and the first 5 rows. Set **Iterations** (1 to 10,000; it starts at the number of rows) and **Delay (ms)** between requests (0 to 60,000; Stop ends a wait at once). Iteration *i* runs every selected request in order with row `(i - 1) % rows`, so more iterations than rows start over at the first row. Without a data file, iterations repeat the run as it is.

- **CSV** follows RFC 4180: a header row, then one row per line. Fields may be quoted, with `""` for a quote and commas or line breaks inside the quotes. CRLF and LF line endings and a BOM at the start are fine; blank lines are skipped. A row with the wrong number of fields, or a duplicate column name, is an error that names its line.
- **JSON** is an array of flat objects. Numbers and booleans become their JSON text, nested values their JSON, and `null` an empty string. A key a row doesn't have is not set for that iteration.
- Limits: 5 MB, 10,000 rows, 200 columns, and column names of at most 200 characters. `__proto__`, `constructor` and `prototype` can't be column names.

Variables resolve in this order, each over the one before: collection, environment, **the iteration's data row**, then runtime variables. So `{{email}}` is the row's email unless a script set `email` with `env.set` or `pm.*.set`. Runtime variables carry from one request to the next and from one iteration to the next, as in any run: a value a script sets in iteration 1 wins over the data in later iterations too, so name script-set variables apart from your columns. Scripts read the row with `iteration.data` or `pm.iterationData`.

The results are grouped by iteration, each labelled with its row's first column, and the summary reads "3 iterations · 3 passed · 0 failed · …". Stop on first failure ends the whole run. Janus's `get_run_results` gives each send's iteration number and row label.

Data files are read by the app's main process only, and only when you chose the file on this computer: a file edited or replaced since you chose it must be chosen again. These choices are kept apart from file-upload choices, so a data file never becomes uploadable. The Runner remembers the file's path, the iterations and the delay per collection, never the data. Data values can be secrets: a value in a column whose name looks secret (password, token, key, secret…) shows as `{{column}}` in the preview, the results, history and what Janus reads, and a value that equals a known secret is hidden as that secret's name.

The demo collection has `data/users.csv` (columns `name,email,role`, 3 rows) and **data-driven/Create user (data-driven)**: choose the file in the Runner, run the `data-driven` folder, and each iteration posts its row's name and email to the echo endpoint and checks the echo against `iteration.data`.

## Command line

`janus` runs a collection folder without the app — for CI or a quick check from a terminal. It needs Node 22 or later.

```sh
npx -y pnpm@10 install
npx -y pnpm@10 --filter @apijanus/cli build     # writes apps/cli/dist/janus.mjs (one self-contained file)
node apps/cli/dist/janus.mjs run ./my-collection -e Staging -r cli,junit
```

- `janus run <collection-dir> [folder-path]` runs every request in the app's runner order; `folder-path` (such as `auth/basic`) runs one folder. `janus run --help` lists every option.
- Variables: `--var name=value` or a `JANUS_VAR_name` shell variable (`--var` wins). They override the environment; data rows and values scripts set override them.
- Secret variables are kept by the app in its encrypted store, which `janus` can't read: pass them with `--var` or `JANUS_VAR_`. A request that needs a secret with no value is reported as an error and not sent, and the run warns about it up front. Every value you pass (of 4 or more characters) is hidden in output and reports.
- `-d data.csv`, `-n`, `--delay`, `--bail`, `--timeout`, `--insecure`, `--ca`, `--cert/--key` (passphrase from `JANUS_CERT_PASSPHRASE`), `--proxy`/`--no-proxy` (default: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`), `--allow-outside-files`.
- Reports: `-r cli,json,junit -o reports/` writes `janus-report.json` and `junit.xml`. Reports never contain response bodies. They are written even when the run is interrupted.
- Exit codes: `0` all passed, `1` a request failed or errored (or was skipped by `--bail`), `2` usage or setup problem, `130` interrupted. Ctrl-C stops the run and writes the reports; a second Ctrl-C quits at once. A report that can't be written counts as a failure (`1`, or `130` if interrupted).

GitHub Actions — `janus` is not published as a package: build `janus.mjs` as above and commit the file to your API-tests repository (here as `tools/janus.mjs`).

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: node tools/janus.mjs run ./api-tests -e Staging -r cli,junit -o reports
  env:
    JANUS_VAR_token: ${{ secrets.API_TOKEN }}
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: api-test-reports, path: reports }
```

## File uploads

A **multipart form** field can be **Text** or **File**, and a **Binary** body sends one file as the whole body. Choose the file with **Choose file…** or drop it onto the row. The file is read only when you send, streamed from disk, never loaded into memory whole.

- **Where the path is stored.** A file inside the collection is stored as a path relative to the collection, such as `files/logo.png`, so teammates who clone the collection have it too. A file outside the collection is stored as its absolute path, and the editor warns: "This file is outside the collection; teammates won't have it." A relative path can never climb out of the collection with `..`; such a path is refused when you send.
- **Some files need your choice on this computer.** A cloned or imported collection can name any file. So these files are sent only if you picked them with **Choose file…** or dropped them on a File row on this computer:
  - a file whose real path is **outside the collection**, such as `~/.ssh/id_rsa`;
  - a **hidden** file inside the collection: any path with a part that starts with `.`, such as `.apijanus/` (JanusAPI's own history), `.git/`, `.env`, `.netrc`, `.npmrc` or `.pypirc`;
  - a **key or credential** file inside the collection: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.kdbx`, `*.ppk`, `id_rsa*`, `id_ecdsa*`, `id_ed25519*`, `credentials`, or a name containing `.env`. Names are matched without regard to case, after the path is normalised (separators, `.` and `..`, and Unicode NFC and NFD);
  - a **hard link** inside the collection (a file with more than one link).

  Ordinary files inside the collection need no choosing. JanusAPI keeps the list of your choices in its own app data, never in the collection, with each file's real path, device and inode, size and modified time. If the file is replaced or edited, choose it again. The list keeps the 5,000 most recent choices, and a damaged list is treated as empty. Every send checks this before any byte goes out: **Send**, collection runs, Janus sends and **Copy as cURL**. A file that wasn't chosen is refused with a message such as "*name* is outside this collection and wasn't chosen on this computer. Choose it again to allow it.", and its row shows **Choose again**.
- **Paths from another system.** An absolute path written on another operating system (such as `C:\…` on a Mac) is refused; choose the file again.
- **Content type.** Each part's `Content-Type` comes from the file's extension (a small built-in map; `application/octet-stream` when unknown). The content type field overrides it. For a binary body, a `Content-Type` header you set wins.
- **File names.** Each part's `Content-Disposition` carries the file name (RFC 7578). A name with non-ASCII characters also gets `filename*` (UTF-8).
- **Limits and checks.** A file can be at most 100 MB, and one request can upload at most 200 MB in all. Before anything is sent, a missing file, a folder, an unreadable file or one over the limit stops the send with a clear error. `Content-Length` is always set.
- **Links.** Choosing a file that is a symbolic link stores the path of the file it points to. When a request is sent, no symbolic link is followed, whether it is the file itself or a folder on its path (inside the collection or not): the send is refused. A dropped link is refused too.
- **Redirects.** A 307 or 308 redirect to the same origin (scheme, host and port) sends the file again, read from disk again. A 307 or 308 to another site is refused, and the file is not sent there. Requests without files follow redirects as before.
- **Timeouts.** A slow upload is never cut off for taking long. The 30-second timeout applies to each wait instead: the server accepting no more of the body for 30 seconds, the response headers not arriving within 30 seconds of the body being sent, or no response bytes for 30 seconds.
- **Copy as cURL** writes a file field as `-F 'name=@/absolute/path;type=…'` and a binary body as `--data-binary '@/absolute/path'`; hiding secrets keeps file paths. Importing a cURL command with `-F name=@path` or a lone `--data-binary @path` gives a file field or binary body with no file chosen, and the preview says "Choose a file for *name* (the command used *path*)". The command's path is only named there, never kept. `@-` (standard input) is not read. Postman, OpenAPI and Swagger imports keep file parameters as file fields with no file chosen, and the preview says which ones need a file.
- **Janus** sees a file only as its field name, file name and size, never its folder or contents. It sees the size only when a send would accept the file: a file that needs choosing shows only its name and "needs choosing", and a file a send would refuse shows no size. The approval card shows you where each file is (for example "in this collection: files/logo.png"); Janus never sees that. Janus cannot choose or change a file. Every Janus send that uploads a file asks you first and lists the files, whatever **Ask before sending** says.
- **History** records each file part as `[file name.ext, N bytes]`, never its path or bytes.

The demo collection has two examples in `bodies/`: **Upload a file (multipart)** and **Binary upload**. They send `files/sample.txt` and `files/logo.png`, and their tests check the size and SHA-256 the mock API reports.

## Digest and AWS Signature v4 auth

Besides None, Bearer, Basic, API key, JWT Bearer and OAuth 2.0, the Auth tab offers **Digest** and **AWS Signature**. Every field takes `{{variables}}`. The password, the AWS secret access key and the session token are secrets: keep them in secret environment variables. If you type them in literally, they are still masked in history and in everything Janus sees, and Janus cannot read them or write them back.

### Digest (RFC 7616, RFC 2617)

Usually you only fill in the user name and password. **Advanced** has overrides for the algorithm, realm, nonce, qop and opaque. Leave them empty and the server's challenge decides. The algorithm is a preference: it is used when the server offers it. Otherwise the server's strongest offer is used, and the response shows a notice saying so. The auth editor warns about Digest over `http://`, where anyone on the network path could send a weak challenge and attack the answer.

- The request goes out without credentials. If the answer is a 401 with a `WWW-Authenticate: Digest …` challenge, JanusAPI answers it **once**. It never loops: if the second answer is also a 401, that is the response you see.
- When the server offers several Digest challenges, JanusAPI picks the strongest it supports: SHA-256, then SHA-256-sess, then MD5, then MD5-sess. It uses `qop=auth`, or `auth-int` when that is the only protection offered and the body is not a file. Each answer has a random cnonce and a nonce count.
- The last nonce for each origin is remembered while the app is running. Only the server's own challenge is remembered, never a request's overrides, and only from a response on that origin (a `nextnonce` from another origin is ignored). The next request there answers it straight away, with the next nonce count. A `stale=true` challenge, or any new challenge, replaces the remembered nonce. That send still makes only one retry.
- Digest credentials are never sent to another origin. A challenge from another origin, for example after a redirect, is not answered. The Digest `Authorization` header is dropped on every redirect hop. The retry goes to the URL that challenged: the request's own URL, or, for GET and HEAD, the same-origin URL it was redirected to.
- The retry of a file upload streams the file from disk again, with the same checks as the first send. If the file changed in between, the send fails with "Digest auth needs to send the request again, but its file could not be sent again: …".

### AWS Signature v4

Fill in the access key ID, the secret access key, an optional session token, the region and the service, for example `execute-api` or `s3`. **Sign body** is on by default.

- Every send is signed after its scripts ran and its variables were resolved, with a fresh `X-Amz-Date`. JanusAPI adds `Authorization`, `X-Amz-Date` and, with a session token, `X-Amz-Security-Token`.
- The signed headers are `host`, `content-type` when present, and every `x-amz-*` header. The path is URI-encoded once more and normalized, except for S3, whose path is encoded once and kept as it is. The query is sorted and encoded.
- The payload hash is the SHA-256 of the body. For a file body (binary or multipart with files), S3 gets `UNSIGNED-PAYLOAD` and the files are streamed once. Other services refuse an unsigned body, so the files are streamed from disk once to hash them, then again to send them, each time checking that they did not change. **Sign body** off sends `UNSIGNED-PAYLOAD` to any service. S3 always gets `x-amz-content-sha256`. Other services get it only for `UNSIGNED-PAYLOAD`. An `x-amz-content-sha256` header you set yourself is kept and signed.
- On a redirect to another origin, `Authorization`, `X-Amz-Security-Token`, `X-Amz-Date`, `X-Amz-Content-Sha256` and every other `x-amz-*` header are dropped, so the session token never leaves the origin it was meant for.
- The signature is checked against the AWS Signature Version 4 test suite and the S3 examples in the AWS documentation.

### Copy as cURL and import

Copy as cURL lets curl do the work. Digest becomes `--digest -u 'user:pass'`. AWS becomes `--aws-sigv4 'aws:amz:REGION:SERVICE' -u 'KEY:SECRET'`, plus `-H 'x-amz-security-token: …'` with a session token. In hide-secrets mode, the password, secret key and token become `{{password}}`, `{{aws_secret_access_key}}` and `{{aws_session_token}}`, or the name of the variable they came from.

On Windows, Copy as cURL writes a `curl.exe` command for cmd (double quotes, `^` line continuations); elsewhere it writes a POSIX shell command. cmd cannot take a line break or control character inside a value, so on Windows a request with one (for example a formatted JSON body) is not copied, and the toast points you to Code → PowerShell or cURL (POSIX). The Code dialog still shows what cmd would need.

Postman's `digest` and `awsv4` auth are imported, with typed-in credentials moved to environment secrets. Postman's saved Digest nonce and opaque come from its last challenge, so they are left out and the server gives fresh ones. Its default Digest algorithm, MD5, is left out too, so the server's strongest offer is used. An AWS auth with no region or service imports with a warning. AWS signing in the query (`addAuthDataToQuery`) isn't supported: the request is signed in the `Authorization` header, and the import warns about it.

The demo collection has **Digest auth** and **AWS Signature v4** in `auth/`. The mock API checks a real Digest answer (SHA-256 or MD5, with expiring nonces and replay checks) and recomputes the SigV4 signature (with at most 15 minutes of clock skew), using the demo's `DIGEST_PASSWORD`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` secrets and `AWS_REGION`.

## Code snippets

**Code** on the request toolbar shows the request as code: cURL, JavaScript `fetch`, Node.js axios, Python requests, Go `net/http`, HTTPie or PowerShell `Invoke-RestMethod` or cURL (Windows cmd). The language you pick is remembered. Every language is built from the same model as Copy as cURL, so it is the request exactly as Send builds it (variables, auth, cookies, proxy and certificates, file fields), without running any script and without sending anything.

- Secrets are shown as `{{NAME}}` placeholders inside the string literals. **Show real values** asks main for the real code at that moment; the window gets no code until the panel asks for it. **Copy** is built and written to the clipboard by main, so the copied text never passes through the window.
- Strings are escaped for each language: JSON string literals for JavaScript, Python and Go (`strconv.Quote`) literals, PowerShell single-quoted strings (typographic quotes doubled too) and shell quoting for HTTPie. A NUL character is refused, as with cURL.
- Auth that needs a handshake or signing is never faked. A JWT is the token signed for this copy and an OAuth 2.0 token is the cached one. Digest uses the language's own support where there is one (Python `HTTPDigestAuth`, HTTPie `--auth-type=digest`) and otherwise a comment names the usual helper. AWS Signature v4 uses `requests-aws4auth` in Python and a comment elsewhere.
- Multipart bodies read files with `fs.openAsBlob` (Node 20+) in JavaScript, and binary bodies stream the file. Proxy and certificate settings go in where the language takes them simply (Python `proxies=`, `verify=`, `cert=`; HTTPie `--proxy`, `--verify`, `--cert`; axios `proxy` and an `https.Agent`); elsewhere a comment says what Send uses.

## Viewing responses

The **Body** tab of a response has a view switch:

- **Pretty** formats JSON, with collapsible objects and arrays, and indents XML. It is offered for JSON and XML bodies up to 2 MB. A larger body is shown as raw text, with the note "Large response: showing raw text".
- **Raw** shows the text exactly as received.
- **Preview** is offered for HTML and for PNG, JPEG, GIF, WebP and SVG images. HTML renders in a sandboxed frame with no permissions, and a Content-Security-Policy placed first in the document stops every network request: no scripts, remote images, styles, fonts, forms or beacons. Images, SVG included, render through an `<img>` element, so an SVG's scripts never run.

JanusAPI remembers your choice for each kind of content.

- **Search.** Press ⌘F (Ctrl+F) while the Body tab shows. While you type in the request editors, ⌘F is left to them. The search bar counts matches, steps through them with Enter and Shift+Enter, and can match case or use a regular expression. Esc closes it. Search counts at most 10,000 matches. A regular expression that would be too slow is stopped and the bar says so. Above 2 MB, at most 1,000 matches are highlighted at once.
- **JSON filter.** Above a pretty JSON body, type a JSON path such as `$.items[0:2]` or `$..book[?(@.price < 10 && @.isbn)].title`. Supported:
  - `$`, `.name`, `['name']`, `[n]` (negative from the end), `[start:end:step]`, `*`, `..` and unions `[a,b]`;
  - filters `[?(@.x op value)]` with `==`, `!=`, `<`, `<=`, `>` and `>=` on numbers, strings, `true`, `false` and `null`, existence checks `[?(@.x)]`, and `&&` and `||`.

  The filter reads own properties only, and a path may be at most 500 characters. It returns at most 10,000 results and stops a path that visits too many nodes.
- **Copy body** copies what the view shows: raw, pretty or filtered.
- **Save response…** writes the exact bytes received to a file you choose. The suggested name comes from `Content-Disposition`, or else the URL. If the response was larger than the 10 MB that JanusAPI keeps, only the first 10 MB are saved, and a message says so.

## Cookies

JanusAPI keeps a cookie jar for each collection and environment, like a browser does.

- **Automatic.** When a response sets a cookie (`Set-Cookie`, including on redirect hops), the cookie is stored. Later requests whose URL matches it send it in a `Cookie` header. Matching follows RFC 6265:
  - the domain must match. A cookie without a `Domain` attribute goes only to the exact host that set it;
  - the request path must be the cookie's path or below it, so `/a` matches `/a/b` but not `/ab`;
  - `Secure` cookies are sent only over https, or to `localhost` and `127.0.0.1`. A plain-http response can't set a `Secure` cookie, or overwrite or delete one with the same name for an overlapping domain and path;
  - `Expires` and `Max-Age` are honoured, and `Max-Age=0` deletes the cookie. Expiry is capped at 400 days from when the cookie is set;
  - `HttpOnly` cookies are stored and sent like any other. `SameSite` is ignored.

  Cookies with longer paths are sent first. Each site keeps at most 150 cookies, counting all its subdomains, and the jar keeps at most 3000. A site is the registrable domain, such as `example.com` or `example.co.uk`. When a site is full, its oldest cookie is dropped. When the jar is full, the oldest cookie of the site with the most cookies is dropped. A cookie larger than 4 KB is refused.
- **Your own `Cookie` header wins.** If a request, or its pre-request script, sets a `Cookie` header, the jar adds nothing to that request. Its response cookies are still stored. If a redirect goes to another origin, your header is dropped for that hop, so the jar adds its matching cookies there instead.
- **Opting out.** Tick **Don't send or save cookies** under a request's Headers tab. That request then neither sends nor stores cookies. In the request file this is `cookies: false`.
- **Which requests use the jar.** Sends you make, collection runs and Janus's sends all use it. Fetching a GraphQL schema does not. **Copy as cURL** adds the jar's cookies as a `-H 'Cookie: …'` header, so the command behaves like Send.
- **Scope and storage.** Each collection and environment has its own jar, so switching environment switches jars. Jars are keyed by the environment's name. JanusAPI has no way to rename an environment, so if you rename one by editing its file, its cookies stay under the old name and the renamed environment starts with an empty jar. The jars are saved encrypted, with the same system keychain or keyring encryption as secret variables, and are never written as plain text. If secure storage is unavailable, cookies last until JanusAPI quits. A damaged cookie file is ignored with a warning and the jar starts empty.
- **Public suffixes.** A cookie whose `Domain` is a public suffix (`com`, `co.uk`, `github.io`, …) is refused. JanusAPI doesn't include the full public suffix list. It refuses any single-label domain except `localhost`, plus a built-in list of common multi-label suffixes. A suffix outside that list is not recognised.
- **Managing cookies.** Open **Settings → Cookies**, or click **Cookies** above a response's headers. You can see the open collection's cookies for the active environment, grouped by domain. Values are hidden until you click **Reveal**. You can edit a cookie's value, path, expiry, Secure and HttpOnly flags. You can also add a cookie, delete one, clear a domain or clear all.
- **Scripts** can read the jar's cookies that match the request URL with `pm.cookies.get(name)`, `pm.cookies.has(name)` and `pm.cookies.toObject()`. These come from the jar even when the request has its own `Cookie` header, in which case the jar's cookies are not sent.
- **Privacy.** Your own views show cookie values as they are: the response pane, and the cookie manager once you click **Reveal**. The response headers view hides `Cookie` and `Set-Cookie` values as `[redacted]`, as it always has; use the cookie manager to see them. Wherever data leaves your hands or is written to disk, cookie values are treated as secrets and shown as `{{cookie.NAME}}`:
  - Janus's view of requests and responses;
  - history;
  - runner results;
  - Copy as cURL with secrets hidden. Its `Cookie` header writes every jar cookie as `{{cookie.NAME}}`.

  Every cookie value of 4 or more characters that a send or run used or received is hidden. Other cookies in the jar are hidden if their value has 8 or more characters, or if they are `HttpOnly` or `Secure` with 4 or more. Only the 200 most recently used cookies count for that rule.

## Network: proxy and certificates

**Settings → Network** holds app-wide network settings. They apply to every collection on this computer and are never written into a collection.

### Proxy

- **Use the system proxy** (the default). JanusAPI asks the system which proxy to use for each host, the way Chromium does, so the system proxy settings and PAC files are followed. Answers are reused for 60 seconds per host. The answer's list is read in order: the first `PROXY` or `HTTPS` entry is used, SOCKS entries are skipped, and a request goes direct only when the list reaches `DIRECT`. JanusAPI never falls back to a direct connection on its own. If the system names only SOCKS proxies (not supported yet), or the settings can't be read, the send stops with a message asking you to choose Manual or Off. Only the first usable entry is tried: if that proxy is down, the send fails rather than trying the next entry.
- **Manual proxy.** An `http://` or `https://` proxy URL, such as `http://proxy.example.com:8080`. SOCKS proxies are refused with a message. The **bypass list** names hosts that connect directly, comma separated. It defaults to `localhost, 127.0.0.1, ::1, *.local`. A pattern can be an exact host or IP address (`localhost`, `::1`), `*.corp` (any subdomain of `corp`), `.example.com` (`example.com` and its subdomains), a CIDR range (`10.0.0.0/8`), or any of these with `:port`. A trailing dot is ignored. `*` bypasses everything.
- **No proxy.** Every request connects directly.

Loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1` and `0.0.0.0`) always connects directly, in every mode, as in Chromium. To send loopback through a manual proxy, for example to inspect local traffic, add `<-loopback>` to the bypass list.

How it works: an `http://` target is sent to the proxy in absolute form, and an `https://` target goes through a `CONNECT host:port` tunnel, with TLS end to end to the target. The target's certificate is always checked against the target's own host name or IP address, never the proxy's. With a proxy user name and password, the `Proxy-Authorization: Basic …` header goes only to the proxy, never to the target. Each redirect hop decides proxy or direct from its own host. The password is kept in the system keychain or keyring (like secret variables). Settings can set or remove it but never shows it again, and it is dropped when you change the proxy URL or user name.

To skip the proxy for one request, tick **Don't use proxy** under its Headers tab (`proxy: false` in the request file). Its OAuth 2.0 token request still uses the proxy, because the token endpoint is another host.

### Trusted certificates

Add PEM files of CA certificates, for servers signed by a private or company CA. They are trusted in addition to Node's default roots (the bundled roots plus any `NODE_EXTRA_CA_CERTS`). Each file is checked when you add it, and its subject and expiry are shown. **Also trust the operating system's root certificates** (macOS keychain, Windows certificate store, Linux system store) adds the operating system's trusted roots as well. A collection's **allow self-signed** setting still works as before.

### Client certificates (mTLS)

Each entry has a host pattern (`api.example.com`, `api.example.com:8443`, or `*.example.com`, where `*` covers one label on the left) and either a PEM certificate and private key or a PKCS#12 (`.p12`/`.pfx`) file, with an optional passphrase. When a server is contacted over https, the first entry whose pattern matches is offered. Entries are checked when added: a wrong passphrase or a key that doesn't match its certificate is reported in words, never with key material. The passphrase is kept in the system keychain or keyring and never shown again.

### Files

Certificate and key files are chosen in the file dialog and recorded as chosen on this computer, with the same mechanism as uploads but in their own list (so choosing a key for mTLS never makes it uploadable by a collection). If a file changes after you chose it, it is refused with "choose it again" until you remove and add it again.

### Test connection

Enter a URL and click **Test connection**. JanusAPI sends one GET with the current settings, without following redirects, and reports whether it went direct or through which proxy, the TLS result (verified and the issuer, or the error), whether a client certificate was offered, and the HTTP status or error.

### Where the settings apply

Sends, collection runs, Janus's sends, OAuth token requests, GraphQL schema fetches, the import-from-URL download, and AI provider calls (Anthropic, OpenAI-compatible and Ollama, through their SDKs' `fetch`) all use these settings. A local Ollama on `localhost` stays direct: loopback is never proxied in system mode, and it's on the default bypass list in manual mode.

- **History** records the proxy (`host:port`) and the TLS issuer as metadata only.
- **Copy as cURL** adds `--proxy http://host:port`, `--proxy-user user:password` (`user:{{proxy_password}}` with secrets hidden), `--cacert` for each trusted file, and `--cert`/`--key` (or `--cert … --cert-type P12`) with `--pass` (`{{cert_passphrase}}` with secrets hidden) for the matching client certificate. Note that curl's `--cacert` replaces curl's default CA bundle rather than adding to it.
- The proxy password, passphrases and key contents never reach Janus, history, logs or the window.

## License

JanusAPI is released under the [MIT License](LICENSE). Project page: [mehtastack.com/janusapi](https://mehtastack.com/janusapi).
