import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface ProxyRecord { method: string; url: string; headers: http.IncomingHttpHeaders }

/**
 * A local HTTP proxy that records what it is asked: absolute-form requests (forwarded without Proxy-Authorization) and CONNECT
 * tunnels. With `auth`, a request without that exact Proxy-Authorization gets 407.
 */
export async function recordingProxy(opts: { auth?: string } = {}): Promise<{ url: string; port: number; seen: ProxyRecord[]; close(): Promise<void> }> {
  const seen: ProxyRecord[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers });
    if (opts.auth && req.headers['proxy-authorization'] !== opts.auth) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' }).end();
      return;
    }
    let target: URL;
    try { target = new URL(req.url!); } catch { res.writeHead(400).end('absolute-form expected'); return; }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const up = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode!, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end('bad gateway'));
    req.pipe(up);
  });
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    seen.push({ method: 'CONNECT', url: req.url!, headers: req.headers });
    sockets.add(client);
    client.on('error', () => {});
    if (opts.auth && req.headers['proxy-authorization'] !== opts.auth) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const i = req.url!.lastIndexOf(':');
    const host = req.url!.slice(0, i).replace(/^\[|\]$/g, '');
    const up = net.connect({ host, port: Number(req.url!.slice(i + 1)) }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    sockets.add(up);
    up.on('error', () => client.destroy());
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
