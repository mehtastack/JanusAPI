# ApiJanus

## AI-Native Open-Source API Client

**Status:** MVP Product Specification
**Project:** ApiJanus
**Platform:** Electron desktop app (macOS first)
**License:** MIT
**Design spec (M1+M2):** [docs/superpowers/specs/2026-10-05-apijanus-m1-m2-design.md](docs/superpowers/specs/2026-10-05-apijanus-m1-m2-design.md)
**Target:** Developers, API engineers, QA engineers, AI-assisted development workflows

---

# 1. Product Vision

**ApiJanus is an open-source, AI-native API development environment.**

The goal is not to create another Postman clone.

The goal is to create:

> **"An AI pilot that understands, executes, tests, and debugs your APIs."**

Traditional API clients require developers to manually construct requests, inspect responses, understand errors, write tests, and modify requests.

ApiJanus adds an AI agent that can operate these capabilities on behalf of the developer while keeping the developer in control.

### Example

Developer:

> "This endpoint is returning 401. Find out why and fix the request."

ApiJanus:

1. Reads the current request.
2. Reads the active environment.
3. Executes the request.
4. Inspects the response.
5. Identifies the authentication problem.
6. Explains the problem.
7. Proposes a change.
8. Gets user approval.
9. Applies the change.
10. Executes the request again.
11. Confirms the result.

---

# 2. Product Positioning

### Existing API clients

```text
Developer
   ↓
Create request
   ↓
Send
   ↓
Read response
   ↓
Manually debug
```

### ApiJanus

```text
Developer
   ↓
Describe intent
   ↓
AI Agent
   ↓
Understand API context
   ↓
Execute tools
   ↓
Inspect result
   ↓
Reason
   ↓
Propose / apply changes
   ↓
Verify
```

ApiJanus should feel closer to **Cursor for API development** than a traditional Postman replacement.

---

# 3. MVP Goals

The MVP must prove one core hypothesis:

> **Developers can use an LLM to accomplish common API-development tasks faster than manually operating an API client.**

The MVP should therefore focus heavily on the **AI Agent**, paired with a solid, focused API client core.

### MVP must support

* ApiJanus collections (plain YAML files, git-friendly)
* REST requests
* Environments
* Request execution
* Response inspection
* AI chat
* AI request generation
* AI request modification
* AI API debugging
* AI test generation
* AI response explanation
* Human approval before destructive changes
* Multiple LLM providers
* Local/self-hosted LLM support where practical
* OpenAI-compatible APIs
* Conversation context

---

# 4. Non-Goals for MVP

Do NOT attempt to build all of these initially:

* Full Postman feature parity
* Cloud synchronization
* Team collaboration
* API marketplace
* API monitoring
* Mock servers
* Enterprise SSO
* Billing
* AI fine-tuning
* Custom model training
* Autonomous unrestricted agent execution
* Complex multi-agent architecture
* Mobile application

These can come later.

---

# 5. Target Users

## Primary

### Backend Developer

Needs to:

* Explore APIs
* Debug requests
* Generate requests
* Test endpoints
* Understand API errors

### Full-stack Developer

Needs:

* Quick API exploration
* Authentication debugging
* Request generation
* Test generation

### QA Engineer

Needs:

* Generate API tests
* Run collections
* Analyze failures
* Create assertions

### API Engineer

Needs:

* OpenAPI exploration
* Request generation
* API debugging
* Environment management

---

# 6. Core MVP Experience

The main ApiJanus interface should contain:

```text
┌─────────────────────────────────────────────────────────────┐
│ ApiJanus                                      Model: Claude │
├───────────────┬─────────────────────────────┬───────────────┤
│               │                             │               │
│ Collections   │ Request                     │ AI Janus      │
│               │                             │               │
│ ▾ Users       │ POST /users                 │ 🤖            │
│   GET users   │                             │               │
│   POST users  │ URL                         │ What can I    │
│               │ {{baseUrl}}/users            │ help with?    │
│ ▾ Payments    │                             │               │
│               │ Headers                     │               │
│ ▾ Auth        │ Authorization: Bearer ...    │               │
│               │                             │               │
│               │ Body                        │               │
│               │ { "name": "John" }           │               │
│               │                             │               │
│               │ [ Send ]                    │               │
│               │                             │               │
│               ├─────────────────────────────┤               │
│               │ Response                    │               │
│               │ 201 Created                 │               │
│               │                             │               │
│               │ { ... }                     │               │
│               │                             │               │
└───────────────┴─────────────────────────────┴───────────────┘
```

The final layout is a workbench (icon rail, collection tree, side-by-side request/response, Janus dock along the bottom). See the design spec, section 7.

---

# 7. Janus AI Agent

The AI agent is the primary new component.

The agent should have access to controlled tools rather than unrestricted access to the application.

## MVP Agent Tools

### Request tools

```text
get_current_request
create_request
update_request
delete_request
duplicate_request
```

### Execution tools

```text
send_request
get_last_response
run_collection
```

### Environment tools

```text
get_environment
get_environment_variable
set_environment_variable
```

### Analysis tools

```text
inspect_response
explain_error
generate_request
generate_test
```

### Collection tools

```text
list_collections
list_requests
get_request
```

---

# 8. Tool Permission Model

AI must not have unrestricted access.

Every tool should have a permission level.

```text
READ
  ↓
ANALYZE
  ↓
EXECUTE
  ↓
MODIFY
  ↓
DESTRUCTIVE
```

### Example

| Tool               | Permission  |
| ------------------ | ----------- |
| Get request        | READ        |
| Get response       | READ        |
| Get environment    | READ        |
| Send request       | EXECUTE     |
| Generate test      | MODIFY      |
| Update request     | MODIFY      |
| Delete request     | DESTRUCTIVE |
| Delete environment | DESTRUCTIVE |

For MVP:

**READ + ANALYZE** can happen automatically.

**EXECUTE** should be configurable.

**MODIFY** requires confirmation.

**DESTRUCTIVE** always requires explicit confirmation.

---

# 9. AI Context

The LLM needs structured context.

Do NOT dump the entire workspace into every prompt.

ApiJanus should construct context dynamically.

## Request context

```json
{
  "method": "POST",
  "url": "{{baseUrl}}/users",
  "headers": {},
  "query": {},
  "body": {},
  "authentication": {},
  "scripts": {}
}
```

## Environment context

```json
{
  "name": "Development",
  "variables": [
    {
      "name": "baseUrl",
      "value": "http://localhost:3000"
    }
  ]
}
```

Sensitive values should be masked by default.

```text
API_KEY = ********
DATABASE_PASSWORD = ********
```

The model should not receive secrets unless explicitly required and permitted.

---

# 10. Primary AI Use Cases

## 10.1 Generate Request

User:

> Create a request for creating a GitHub issue.

AI:

```text
POST https://api.github.com/repos/{{owner}}/{{repo}}/issues

Headers:
Authorization: Bearer {{GITHUB_TOKEN}}
Content-Type: application/json

Body:
{
  "title": "Bug report",
  "body": "..."
}
```

AI presents a preview.

User clicks: **Create Request**

---

# 11. Debug Request

User:

> Why is this request failing?

Agent workflow:

```text
get_current_request()
        ↓
send_request()
        ↓
get_last_response()
        ↓
inspect_response()
        ↓
inspect_environment()
        ↓
reason
        ↓
explain
```

Example:

```text
Janus:

The request is returning HTTP 401.

I found that:

1. Authorization uses {{API_TOKEN}}
2. The active environment doesn't define API_TOKEN
3. The request therefore sends an empty token

Suggested fix:

Create API_TOKEN in the Development environment.

[Apply Fix]
```

---

# 12. Fix Request

User:

> Fix this request and make it work.

Agent:

```text
1. Inspect request
2. Execute request
3. Analyze failure
4. Identify likely cause
5. Propose change
6. Ask for approval
7. Apply change
8. Execute again
9. Verify
```

The agent should never silently modify important user configuration.

---

# 13. Generate Tests

User:

> Generate tests for this endpoint.

AI creates:

```javascript
test("Status is 200", () => {
    expect(res.status).to.equal(200);
});
```

Generated scripts must use the ApiJanus scripting/test API (`test`, `expect`, `req`, `res`, `env`) rather than another tool's syntax.

The agent should understand the ApiJanus request file format.

---

# 14. Explain Response

User:

> Explain this response.

ApiJanus should analyze:

* HTTP status
* Headers
* JSON structure
* Error messages
* Validation errors
* Authentication errors
* Common API patterns

Example:

```text
422 Unprocessable Entity

The API accepted the request format but rejected the
provided data.

The `email` field appears to violate the server's validation
rule.

Expected:
valid email address

Received:
john@
```

---

# 15. Generate Request From Natural Language

User:

> Call our staging user API and get users created today.

Janus should:

1. Identify the relevant collection.
2. Find the user endpoint.
3. Inspect available parameters.
4. Construct the request.
5. Show the request.
6. Execute after approval/configuration.

---

# 16. OpenAPI Integration

MVP should support importing an OpenAPI specification.

Input:

```text
openapi.yaml
```

ApiJanus can provide:

```text
Generate requests
Generate tests
Explain endpoint
Find authentication requirements
Generate example payload
```

Later:

```text
OpenAPI
   ↓
API knowledge graph
   ↓
Janus Agent
```

---

# 17. LLM Provider Architecture

Do not hardcode a single LLM provider.

Create an abstraction:

```typescript
interface LLMProvider {
    chat(messages, options): Promise<LLMResponse>

    stream(messages, options): AsyncIterable<LLMChunk>

    supportsToolCalling(): boolean
}
```

Implement providers such as:

```text
OpenAI
Anthropic
Google
Ollama
OpenAI-compatible
```

MVP can initially ship with:

```text
OpenAI-compatible
Anthropic
Ollama
```

This keeps ApiJanus vendor-neutral.

---

# 18. AI Model Configuration

UI:

```text
Settings
  └── AI

Provider:
[ OpenAI ▼ ]

Model:
[ GPT-... ]

API Key:
[ ************** ]

Temperature:
[------]

Enable tool calling:
[x]

Ask before executing requests:
[x]
```

For local models:

```text
Provider:
Ollama

Endpoint:
http://localhost:11434

Model:
qwen / llama / etc.
```

---

# 19. Conversation Model

Every AI conversation should be associated with a workspace/request context.

```text
Workspace
   └── Collection
        └── Request
             └── AI Conversation
```

The user can ask:

```text
"Why did the last request fail?"
"Try changing the auth."
"Now generate a test."
"Run it again."
```

Janus maintains context across the conversation.

---

# 20. AI Chat UX

The AI panel should support:

```text
User message

Janus response

Tool execution
   ↓
[Reading request]

Tool execution
   ↓
[Sending request]

Tool execution
   ↓
[Analyzing response]

Final answer
```

Tool calls should be visible but not overwhelming.

Example:

```text
🤖 Janus

I'll inspect the request and run it.

✓ Read request
✓ Checked environment
✓ Sent request
✓ Received 401
✓ Analyzed authentication

The token is missing.

[Fix authentication]
```

---

# 21. Approval UX

Before modifying anything:

```text
┌─────────────────────────────────────────┐
│ Janus wants to modify the request       │
├─────────────────────────────────────────┤
│                                         │
│ Authorization                           │
│                                         │
│ - Bearer {{API_TOKEN}}                  │
│ + Bearer {{ACCESS_TOKEN}}               │
│                                         │
│ [Cancel]                [Apply Change]  │
└─────────────────────────────────────────┘
```

Use a diff view wherever possible.

---

# 22. Architecture

Recommended high-level architecture:

```text
                    ┌───────────────────┐
                    │    ApiJanus UI    │
                    │                   │
                    │ Client UI + Janus │
                    └─────────┬─────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │   Janus Agent     │
                    │                   │
                    │ Planner           │
                    │ Context Manager   │
                    │ Tool Executor     │
                    │ Permission Layer  │
                    └─────────┬─────────┘
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
          Request Tools   Workspace     AI Provider
                          Tools
                │             │             │
                ▼             ▼             ▼
           Executor     Collections     LLM
                        (YAML files)
```

---

# 23. Suggested Internal Components

```text
apps/
  desktop/

packages/
  janus-agent/
  janus-llm/
  janus-tools/
  janus-context/
  janus-permissions/
  janus-prompts/
  janus-types/

```

Superseded: the design spec uses `apps/desktop`, `packages/core` and `packages/agent` (section 3).

---

# 24. Agent Runtime

The agent loop:

```text
User Input
    ↓
Build Context
    ↓
LLM
    ↓
Tool Call?
   / \
 No   Yes
 |     |
 ↓     ↓
Answer Execute Tool
         ↓
      Result
         ↓
        LLM
         ↓
   Tool Call / Answer
```

Pseudo-flow:

```typescript
while (!done) {
    const response = await llm.chat(context);

    if (!response.toolCall) {
        return response.text;
    }

    const permission =
        permissionManager.check(response.toolCall);

    if (!permission.allowed) {
        await requestUserApproval();
    }

    const result =
        await toolExecutor.execute(response.toolCall);

    context.addToolResult(result);
}
```

---

# 25. Prompt Architecture

Do not use one giant system prompt.

Separate:

```text
system/
  agent.md

prompts/
  request-generation.md
  debugging.md
  test-generation.md
  response-analysis.md
  openapi.md
```

System prompt should establish:

* Role
* Available tools
* Safety rules
* Permission rules
* ApiJanus file format and script/test API knowledge
* Output conventions

Task-specific prompts provide the current operation.

---

# 26. Security

Security is a first-class MVP requirement.

## Secrets

Never automatically expose the following to the LLM:

* API keys
* OAuth tokens
* passwords
* private certificates
* environment secrets

Use `{{API_KEY}}` rather than `sk-actual-secret-value` where possible.

## Network access

Agent requests should respect the same network/security model as the API client.

## Tool restrictions

The agent cannot:

* Delete collections silently
* Delete environments silently
* Modify secrets silently
* Execute arbitrary local commands
* Read arbitrary filesystem paths

---

# 27. Local-First Philosophy

ApiJanus should stay local-first and developer-friendly.

```text
Local Workspace
      ↓
Local Collections
      ↓
Local Environment
      ↓
Local API execution
      ↓
Optional AI provider
```

The project should not require an ApiJanus cloud account for basic functionality.

---

# 28. Telemetry

MVP should default to **no telemetry** or opt-in telemetry.

Do not send API requests, API responses, environment variables, source code, or AI conversations to a central server unless explicitly configured by the user.

This is important for developer trust.

---

# 29. MVP Feature Priorities

## P0 — Required

### API client

* Request editor
* REST
* Collections
* Environments
* Request execution
* Response viewer

### AI

* AI chat
* LLM provider configuration
* Tool calling
* Request generation
* Request explanation
* Response explanation
* Debug request
* Generate tests

### Agent

* Read request
* Read response
* Execute request
* Modify request
* Generate test
* Permission/approval system

## P1 — After MVP

* OpenAPI import
* cURL → request
* Request → cURL
* AI collection generation
* AI environment generation
* AI documentation generation
* AI API exploration
* Better agent memory
* MCP integration

## P2

* API monitoring
* Mock server
* Team collaboration
* Shared AI context
* GitHub integration
* GitLab integration
* CI/CD integration
* API contract testing
* Autonomous workflows

---

# 30. MVP User Stories

### US-001 — Ask Janus about current request

**Given:** A request is open.
**When:** User asks "Explain this request."
**Then:** Janus explains method, URL, headers, body, auth and environment variables.

### US-002 — Generate request

User: "Create a GET request for `/users/{id}`."
Janus creates a request preview. User approves. Request appears in the collection.

### US-003 — Debug API

User: "Why is this failing?"
Janus executes and analyzes the response, and provides a diagnosis.

### US-004 — Apply fix

Janus identifies `Missing Authorization header`. User clicks **Apply Fix**. Request is modified.

### US-005 — Generate tests

User: "Generate tests for this endpoint."
Janus generates tests using the ApiJanus test API.

### US-006 — Local LLM

User configures Ollama → local model.
Janus operates without sending AI data to a hosted provider.

---

# 31. MVP Success Metrics

### Primary

**AI task completion rate** — percentage of AI tasks successfully completed. Target: **> 70%**

### Secondary

**Request generation acceptance** — percentage of generated requests accepted by users. Target: **> 60%**

**Debug resolution rate** — percentage of debugging sessions where the user accepts the proposed fix. Target: **> 40%**

**Time saved** — manual vs Janus-assisted debugging. Target: **30%+ reduction** for common debugging tasks.

---

# 32. Development Roadmap

## Phase 0 — Foundation (~1 week)

* Scaffold repo and Electron shell
* Build the core API client
* Add AI panel
* Establish package boundaries
* Add LLM abstraction

Deliverable: **API client + AI Chat**

## Phase 1 — Read-only Agent (~1–2 weeks)

Implement `get_current_request`, `get_environment`, `get_last_response`, `list_requests`.

Agent can answer: "What does this request do?", "Why did it fail?", "What environment variables does it use?"

Deliverable: **Context-aware AI assistant**

## Phase 2 — Execution Agent (~1–2 weeks)

Add `send_request`, `run_collection`.

Agent can: "Run this request and explain the result."

Deliverable: **AI + API execution**

## Phase 3 — Modification Agent (~2 weeks)

Add `update_request`, `create_request`, `generate_test`, plus Diff, Approval, Rollback.

Deliverable: **AI can modify API workflows**

## Phase 4 — MVP Release (~1–2 weeks)

* Provider configuration
* Ollama
* OpenAI-compatible provider
* Anthropic
* Security review
* Documentation
* Examples
* Demo workspace
* GitHub release
* Installation packages

---

# 33. Example MVP Demo (2–3 minutes)

1. Open ApiJanus.
2. Import an existing API collection.
3. Select `POST /login`.
4. Ask: "Run this and tell me what's wrong." Janus executes → `401 Unauthorized`.
5. Janus explains: the request's `Authorization` header uses `{{API_TOKEN}}`, which isn't defined in the active environment, so an empty token is sent.
6. User clicks **Apply Fix**.
7. Janus modifies the request.
8. Janus executes again → `200 OK`.
9. User: "Generate tests for this." Janus creates the tests.

That single flow demonstrates the product's core value.

---

# 34. Open Source Strategy

ApiJanus should remain useful without any hosted service.

```text
ApiJanus
   │
   ├── Local API client
   ├── Local workspace
   ├── Local agent
   ├── Local Ollama
   └── External LLM providers (optional)
```

Potential future hosted services can be separate (ApiJanus Cloud, Teams, Enterprise, Agent Cloud), but the open-source client remains independently useful.

---

# 35. Future Direction

> **ApiJanus becomes an autonomous API engineering workspace.**

"Explore this API and create a complete test collection":

```text
Read OpenAPI → Understand endpoints → Create collection → Generate environments
→ Generate requests → Generate tests → Execute tests → Identify failures
→ Fix requests → Generate documentation
```

"Investigate why our staging checkout API is failing" — Janus operates across OpenAPI, collections, environments, requests, responses, logs, tests, Git and MCP, while keeping the developer in control.

---

# 36. Product Principle

> **AI should operate the API client, not replace it.**

The request editor remains the source of truth. The developer remains the decision maker. The AI becomes the **pilot**.

**Janus** — the Roman god of doors, transitions, beginnings, and looking in two directions. ApiJanus sits between:

```text
Human Intent
     ↕
   Janus
     ↕
     API
```

---

# 37. MVP Definition of Done

ApiJanus MVP is ready when a developer can:

* [ ] Open an existing ApiJanus collection
* [ ] Configure an LLM
* [ ] Open a request
* [ ] Ask Janus about the request
* [ ] Ask Janus to execute it
* [ ] Ask Janus to analyze the response
* [ ] Ask Janus to diagnose an error
* [ ] Ask Janus to modify the request
* [ ] Review the modification as a diff
* [ ] Approve the modification
* [ ] Re-run the request
* [ ] Ask Janus to generate tests
* [ ] Run the generated tests
* [ ] Use a local LLM where supported
* [ ] Use ApiJanus without an ApiJanus cloud account
* [ ] Keep API secrets protected

---

# 38. One-Sentence Product Definition

> **ApiJanus is an open-source AI-native API client that lets developers talk to, debug, test, and modify APIs through an intelligent agent.**
