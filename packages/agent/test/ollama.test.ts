import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ollamaModels, createOllamaProvider } from '../src/providers/ollama';

let server: http.Server;
let endpoint = '';
const hung: http.ServerResponse[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'llama3:8b' }, { name: 'old:1b' }] }));
      } else if (req.url === '/bad/api/tags') {
        res.end('<html>nope</html>');
      } else if (req.url === '/hang/api/tags') {
        hung.push(res);
      } else if (req.url === '/flaky/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'broken:1b' }, { name: 'llama3:8b' }] }));
      } else if (req.url === '/flaky/api/show') {
        const model = (JSON.parse(body) as { model: string }).model;
        if (model === 'broken:1b') { res.statusCode = 500; res.end('{}'); }
        else res.end(JSON.stringify({ capabilities: model === 'qwen3:8b' ? ['tools'] : ['completion'] }));
      } else if (req.method === 'POST' && req.url === '/api/show') {
        const model = (JSON.parse(body) as { model: string }).model;
        const caps: Record<string, unknown> = { 'qwen3:8b': ['completion', 'tools'], 'llama3:8b': ['completion'] };
        res.end(JSON.stringify(model in caps ? { capabilities: caps[model] } : {}));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => { for (const h of hung) h.destroy(); server.close(() => r(undefined)); }));

describe('ollama helper', () => {
  it('lists models with their tool capability', async () => {
    expect(await ollamaModels(endpoint)).toEqual([
      { id: 'qwen3:8b', supportsTools: true },
      { id: 'llama3:8b', supportsTools: false },
      { id: 'old:1b' },
    ]);
  });

  it('reports an unreachable endpoint clearly', async () => {
    await expect(ollamaModels('http://127.0.0.1:1')).rejects.toThrow(/Could not reach Ollama at http:\/\/127\.0\.0\.1:1/);
  });

  it('builds a provider that lists models through the helper', async () => {
    const p = createOllamaProvider({ endpoint });
    expect(p.kind).toBe('ollama');
    expect((await p.listModels()).map((m) => m.id)).toEqual(['qwen3:8b', 'llama3:8b', 'old:1b']);
  });

  it('degrades one model whose /api/show fails instead of rejecting', async () => {
    expect(await ollamaModels(`${endpoint}/flaky`)).toEqual([
      { id: 'qwen3:8b', supportsTools: true },
      { id: 'broken:1b' },
      { id: 'llama3:8b', supportsTools: false },
    ]);
  });

  it('explains a non-JSON response', async () => {
    await expect(ollamaModels(`${endpoint}/bad`)).rejects.toThrow(/Ollama at .*\/bad returned an unreadable response/);
  });

  it('times out a hanging endpoint', async () => {
    await expect(ollamaModels(`${endpoint}/hang`, undefined, { timeoutMs: 200 })).rejects.toThrow(/Could not reach Ollama at .*: timed out/);
  });
});
