import { describe, it, expect } from 'vitest';
import { runScript, type ScriptInput } from '../src';

const req = { method: 'POST', url: 'http://h/a', headers: [['Content-Type', 'application/json']] as [string, string][], body: '{"q":1}' };
const body = { token: 'tok-1', items: [{ id: 1 }, { id: 2 }] };
const res = {
  status: 200, statusText: 'OK', headers: { 'content-type': 'application/json', 'x-rate': '9' }, body,
  bodyText: JSON.stringify(body), time: 42, size: 51,
};
const run = (code: string, over: Partial<ScriptInput> = {}) => runScript({ code, req, res, env: { a: 'A', base: 'http://x' }, ...over });

describe('pm compatibility: common Postman snippets', () => {
  it.each([
    ['sets an environment value from the JSON body', `pm.environment.set('token', pm.response.json().token)`, { envSets: { token: 'tok-1' } }],
    ['asserts the status code', `pm.test('status', () => pm.response.to.have.status(200))`, { tests: [{ name: 'status', passed: true }] }],
    ['asserts with pm.expect', `pm.test('two', () => pm.expect(pm.response.json().items).to.have.lengthOf(2))`, { tests: [{ name: 'two', passed: true }] }],
    ['reads a header case-insensitively', `pm.environment.set('ct', pm.response.headers.get('Content-Type'))`, { envSets: { ct: 'application/json' } }],
    ['replaces {{name}} in strings', `pm.variables.set('r', pm.variables.replaceIn('{{a}}-x-{{missing}}'))`, { envSets: { r: 'A-x-{{missing}}' } }],
    ['collects legacy tests[...]', `tests['ok'] = responseCode.code === 200; tests['bad'] = responseCode.code === 404;`, { tests: [{ name: 'ok', passed: true }, { name: 'bad', passed: false }] }],
    ['supports postman.setEnvironmentVariable', `postman.setEnvironmentVariable('t', JSON.parse(responseBody).token); postman.setEnvironmentVariable('b', postman.getEnvironmentVariable('base'))`, { envSets: { t: 'tok-1', b: 'http://x' } }],
  ])('%s', async (_name, code, expected) => {
    const out = await run(code);
    expect(out.ok, out.error).toBe(true);
    expect(out).toMatchObject(expected);
  });

  it('adds a request header in a pre-request script', async () => {
    const out = await runScript({ code: `pm.request.headers.add({ key: 'X-Trace', value: '1' })`, req, env: {} });
    expect(out.ok).toBe(true);
    expect(out.req.headers).toEqual([['Content-Type', 'application/json'], ['X-Trace', '1']]);
  });

  it('upserts, removes and reads request headers, and exposes method, url and body', async () => {
    const out = await runScript({
      code: `
        pm.request.headers.upsert({ key: 'content-type', value: 'text/plain' });
        pm.request.headers.add('X-A: 1');
        pm.request.headers.add({ key: 'X-B', value: '2' });
        pm.request.headers.remove('x-b');
        pm.environment.set('got', pm.request.headers.get('X-A'));
        pm.environment.set('m', pm.request.method);
        pm.environment.set('u', pm.request.url.toString());
        pm.environment.set('u2', 'url=' + pm.request.url);
        pm.environment.set('b', pm.request.body.raw + '|' + String(pm.request.body));
      `,
      req, env: {},
    });
    expect(out.ok, out.error).toBe(true);
    expect(out.req.headers).toEqual([['content-type', 'text/plain'], ['X-A', '1']]);
    expect(out.envSets).toEqual({ got: '1', m: 'POST', u: 'http://h/a', u2: 'url=http://h/a', b: '{"q":1}|{"q":1}' });
  });

  it('gives every variable scope get, set, has, unset and toObject over one runtime layer', async () => {
    const out = await run(`
      pm.collectionVariables.set('c', 1);
      pm.globals.set('g', 'G');
      const seen = [pm.environment.get('c'), pm.variables.get('g'), pm.globals.has('a'), pm.environment.has('nope')].join(',');
      pm.environment.unset('a');
      pm.environment.set('seen', seen + ',' + pm.variables.has('a') + ',' + String(pm.variables.get('a')) + ',' + JSON.stringify(pm.collectionVariables.toObject()));
    `);
    expect(out.ok, out.error).toBe(true);
    expect(out.envSets).toEqual({
      c: '1', g: 'G', a: '',
      seen: '1,G,true,false,false,undefined,{"base":"http://x","c":"1","g":"G"}',
    });
  });

  it('exposes response details and assertion shortcuts', async () => {
    const out = await run(`
      pm.test('details', () => {
        pm.expect(pm.response.code).to.equal(200);
        pm.expect(pm.response.status).to.equal('OK');
        pm.expect(pm.response.responseTime).to.equal(42);
        pm.expect(pm.response.responseSize).to.equal(51);
        pm.expect(pm.response.text()).to.equal(${JSON.stringify(JSON.stringify(body))});
        pm.expect(pm.response.headers.has('X-RATE')).to.equal(true);
        pm.expect(pm.response.headers.toObject()).to.have.property('x-rate', '9');
      });
      pm.test('ok', () => pm.response.to.be.ok);
      pm.test('json', () => pm.response.to.be.json);
      pm.test('jsonBody', () => pm.response.to.have.jsonBody());
      pm.test('header', () => pm.response.to.have.header('Content-Type', 'application/json'));
      pm.test('header missing', () => pm.response.to.have.header('X-None'));
      pm.test('wrong status', () => pm.response.to.have.status(404));
      pm.test('info', () => pm.expect([pm.info.eventName, pm.info.requestName, pm.info.iteration]).to.eql(['test', 'Get', 0]));
      pm.test('env name', () => pm.expect(pm.environment.name).to.equal(''));
    `, { info: { requestName: 'Get' } });
    expect(out.ok, out.error).toBe(true);
    const byName = Object.fromEntries(out.tests.map((t) => [t.name, t]));
    for (const n of ['details', 'ok', 'json', 'jsonBody', 'header', 'info', 'env name']) expect(byName[n], `${n}: ${byName[n]?.error}`).toMatchObject({ passed: true });
    expect(byName['header missing']).toMatchObject({ passed: false, error: expect.stringMatching(/X-None/) });
    expect(byName['wrong status']).toMatchObject({ passed: false, error: expect.stringMatching(/404.*200|200.*404/) });
  });

  it('parses a text body in json() and fails non-2xx with to.be.ok', async () => {
    const out = await run(`pm.test('j', () => pm.expect(pm.response.json().n).to.equal(1)); pm.test('ok', () => pm.response.to.be.ok)`, {
      res: { status: 500, headers: {}, body: '{"n":1}', time: 1 },
    });
    expect(out.tests).toEqual([{ name: 'j', passed: true }, { name: 'ok', passed: false, error: expect.stringMatching(/500/) }]);
  });

  it('reports the pre-request event name', async () => {
    const out = await runScript({ code: `pm.environment.set('e', pm.info.eventName + ':' + pm.info.requestName)`, req, env: {} });
    expect(out.envSets).toEqual({ e: 'prerequest:' });
  });
});

describe('pm.cookies', () => {
  const cookies = [{ name: 'session', value: 's-1' }, { name: 'theme', value: 'dark' }, { name: 'session', value: 'older' }];
  it('reads the request cookies: get, has (with an optional value) and toObject, the first cookie of a name winning', async () => {
    const out = await run(`env.set('r', JSON.stringify([pm.cookies.get('session'), pm.cookies.get('nope') === undefined, pm.cookies.has('theme'), pm.cookies.has('theme', 'dark'), pm.cookies.has('theme', 'light'), pm.cookies.has('nope'), pm.cookies.toObject()]))`, { cookies });
    expect(out.ok, out.error).toBe(true);
    expect(JSON.parse(out.envSets.r!)).toEqual(['s-1', true, true, true, false, false, { session: 's-1', theme: 'dark' }]);
  });

  it('is empty when the request carries no cookies', async () => {
    const out = await run(`env.set('r', JSON.stringify([pm.cookies.has('a'), pm.cookies.toObject()]))`);
    expect(JSON.parse(out.envSets.r!)).toEqual([false, {}]);
  });

  it('is read-only: changing what a script sees changes nothing it returns', async () => {
    const out = await run(`pm.cookies.toObject().session = 'x'; env.set('r', pm.cookies.get('session'))`, { cookies });
    expect(out.envSets.r).toBe('s-1');
    for (const code of [`pm.cookies.unset('session')`, `pm.cookies.clear()`]) {
      expect((await run(code, { cookies })).ok).toBe(false);
    }
  });
});

describe('pm compatibility: unsupported features', () => {
  it.each([
    ['pm.sendRequest', `pm.sendRequest('http://x', () => {})`],
    ['pm.cookies.set', `pm.cookies.set('a', '1')`],
    ['pm.cookies.jar', `pm.cookies.jar()`],
    ['pm.vault', `pm.vault.get('a')`],
    ['pm.execution.setNextRequest', `pm.execution.setNextRequest('x')`],
    ['postman.setNextRequest', `postman.setNextRequest('x')`],
    ['pm.visualizer', `pm.visualizer.set('<b></b>')`],
    ['require', `const _ = require('lodash')`],
  ])('%s fails the script with a named error', async (name, code) => {
    const out = await run(code);
    expect(out).toMatchObject({ ok: false, error: `${name} is not supported in JanusAPI scripts` });
  });

  it('fails a pm.test that uses an unsupported feature', async () => {
    const out = await run(`pm.test('t', () => require('moment'))`);
    expect(out.tests).toEqual([{ name: 't', passed: false, error: 'require is not supported in JanusAPI scripts' }]);
  });
});

describe('pm compatibility: isolation', () => {
  it.each([
    [`pm.constructor.constructor('return this')()`],
    [`pm.test.constructor('return this')()`],
    [`pm.response.json.constructor('return this')()`],
    [`pm.request.headers.add.constructor('return this')()`],
    [`Object.getPrototypeOf(pm.environment).constructor.constructor('return this')()`],
  ])('%s reaches only the QuickJS global', async (expr) => {
    const out = await run(`
      const g = ${expr};
      pm.environment.set('same', g === globalThis);
      pm.environment.set('host', [typeof g.process, typeof g.require, typeof g.fetch, typeof g.XMLHttpRequest, typeof g.std, typeof g.os, typeof g.Buffer].join(','));
    `);
    expect(out.ok, out.error).toBe(true);
    expect(out.envSets).toEqual({ same: 'true', host: 'undefined,undefined,undefined,undefined,undefined,undefined,undefined' });
  });

  it('leaves non-pm scripts alone, including ones that assign the legacy names', async () => {
    const out = await run(`tests = 1; responseBody = 2; pm = 3; postman = 4; env.set('t', [tests, responseBody, pm, postman].join(','))`);
    expect(out).toMatchObject({ ok: true, envSets: { t: '1,2,3,4' }, tests: [] });
  });
});

describe('pm review fixes: response bodies', () => {
  it.each([
    ['plain text', 'hello', 'text/plain'],
    ['HTML', '<!doctype html><html><body>Oops</body></html>', 'text/html'],
    ['empty', '', 'text/plain'],
  ])('json() on a %s body throws a clear error', async (_kind, text, type) => {
    const r = { status: 200, headers: { 'content-type': type }, body: text, time: 1 };
    const inTest = await run(`pm.test('j', () => pm.response.json())`, { res: r });
    expect(inTest.tests).toEqual([{ name: 'j', passed: false, error: 'Response body is not valid JSON' }]);
    const top = await run(`pm.response.json()`, { res: r });
    expect(top).toMatchObject({ ok: false, error: 'Response body is not valid JSON' });
    const jb = await run(`pm.test('jb', () => pm.response.to.have.jsonBody())`, { res: r });
    expect(jb.tests[0]).toMatchObject({ passed: false, error: expect.stringMatching(/JSON/) });
  });
});

describe('pm review fixes: pm.response.to chains', () => {
  const results = async (cases: Record<string, string>, over: Partial<ScriptInput> = {}) => {
    const code = Object.entries(cases).map(([n, c]) => `pm.test(${JSON.stringify(n)}, () => { ${c}; });`).join('\n');
    const out = await run(code, over);
    expect(out.ok, out.error).toBe(true);
    return Object.fromEntries(out.tests.map((t) => [t.name, t.passed ? true : t.error]));
  };

  it('supports the common forms, not, and chaining words', async () => {
    const r = await results({
      ok: 'pm.response.to.be.ok',
      notError: 'pm.response.to.not.be.error',
      success: 'pm.response.to.be.success',
      statusN: 'pm.response.to.have.status(200)',
      statusText: "pm.response.to.have.status('OK')",
      notStatus: 'pm.response.to.not.have.status(404)',
      header: "pm.response.to.have.header('Content-Type')",
      headerValue: "pm.response.to.have.header('content-type', 'application/json')",
      notHeader: "pm.response.to.not.have.header('X-None')",
      json: 'pm.response.to.be.json',
      jsonBody: 'pm.response.to.have.jsonBody()',
      jsonPath: "pm.response.to.have.jsonBody('items[1].id')",
      jsonPathValue: "pm.response.to.have.jsonBody('items[0].id', 1)",
      notJsonPath: "pm.response.to.not.have.jsonBody('nope')",
      body: `pm.response.to.have.body(${JSON.stringify(JSON.stringify(body))})`,
      chain: "pm.response.to.have.status(200).and.have.header('x-rate', '9').and.be.ok",
      chain2: 'pm.response.to.be.ok.and.be.json.and.not.be.error',
    });
    for (const [k, v] of Object.entries(r)) expect(v, k).toBe(true);
  });

  it('fails negated and wrong assertions with clear messages', async () => {
    const r = await results({
      notOk: 'pm.response.to.not.be.ok',
      error: 'pm.response.to.be.error',
      notStatus: 'pm.response.to.not.have.status(200)',
      statusText: "pm.response.to.have.status('Not Found')",
      body: "pm.response.to.have.body('nope')",
      jsonPath: "pm.response.to.have.jsonBody('items[5].id')",
      chainFail: "pm.response.to.have.status(200).and.have.header('X-None')",
    });
    expect(r.notOk).toMatch(/not to be ok/);
    expect(r.error).toMatch(/to be an error.*200/);
    expect(r.notStatus).toMatch(/not to have status 200/);
    expect(r.statusText).toMatch(/Not Found/);
    expect(r.body).toMatch(/body/);
    expect(r.jsonPath).toMatch(/items\[5\]\.id/);
    expect(r.chainFail).toMatch(/X-None/);
  });

  it('rejects bad or missing arguments instead of passing', async () => {
    const r = await results({
      noStatus: 'pm.response.to.have.status()',
      objStatus: 'pm.response.to.have.status({})',
      noHeader: 'pm.response.to.have.header()',
      noBody: 'pm.response.to.have.body(5)',
      badPath: 'pm.response.to.have.jsonBody(5)',
    });
    expect(r.noStatus).toBe('pm.response.to.have.status() needs a status code or reason text');
    expect(r.objStatus).toBe('pm.response.to.have.status() needs a status code or reason text');
    expect(r.noHeader).toBe('pm.response.to.have.header() needs a header name');
    expect(r.noBody).toBe('pm.response.to.have.body() needs a string or regular expression');
    expect(r.badPath).toBe('pm.response.to.have.jsonBody() needs a property path string');
  });

  it('names unsupported members of pm.response.to', async () => {
    const r = await results({ a: 'pm.response.to.have.jsonSchema({})', b: 'pm.response.to.be.withBody' });
    expect(r.a).toBe('pm.response.to.have.jsonSchema is not supported in JanusAPI scripts');
    expect(r.b).toBe('pm.response.to.be.withBody is not supported in JanusAPI scripts');
  });

  it('uses the standard reason phrase when the response has none', async () => {
    const r = await results({ s: "pm.expect(pm.response.status).to.equal('Not Found'); pm.response.to.have.status('Not Found')" },
      { res: { status: 404, headers: {}, body: '', time: 1, statusText: '' } });
    expect(r.s).toBe(true);
  });
});

describe('pm review fixes: requests, timers and unsupported objects', () => {
  it.each([
    [`pm.request.headers.add({ value: 'v' })`, 'pm.request.headers.add() needs a header key'],
    [`pm.request.headers.upsert({ key: '', value: 'v' })`, 'pm.request.headers.upsert() needs a header key'],
    [`pm.request.headers.add()`, 'pm.request.headers.add() needs a header key'],
  ])('%s fails with a named error', async (code, error) => {
    const out = await runScript({ code, req, env: {} });
    expect(out).toMatchObject({ ok: false, error });
  });

  it.each(['setTimeout', 'setInterval', 'clearTimeout', 'setImmediate'])('%s gives a named error', async (name) => {
    const out = await run(`${name}(() => {}, 1)`);
    expect(out).toMatchObject({ ok: false, error: `${name} is not supported in JanusAPI scripts` });
  });

  it('lets scripts feature-detect unsupported objects, and fails on use', async () => {
    const out = await run(`env.set('t', [typeof pm.cookies, typeof pm.vault, typeof pm.visualizer, !!pm.cookies].join(','))`);
    expect(out).toMatchObject({ ok: true, envSets: { t: 'object,object,object,true' } });
    expect(await run(`pm.vault.get('a')`)).toMatchObject({ ok: false, error: 'pm.vault is not supported in JanusAPI scripts' });
    expect(await run(`pm.cookies.jar().set('a', '1')`)).toMatchObject({ ok: false, error: 'pm.cookies.jar is not supported in JanusAPI scripts' });
    expect(await run(`pm.cookies.each(() => {})`)).toMatchObject({ ok: false, error: 'pm.cookies.each is not supported in JanusAPI scripts' });
  });

  it('reads parts of pm.request.url and names the unsupported ones', async () => {
    const out = await runScript({
      code: `const u = pm.request.url; env.set('p', [u.getHost(), u.getPath(), u.getQueryString(), u.getPathWithQuery()].join('|'))`,
      req: { ...req, url: 'https://user:pw@api.example.test:8443/v1/items?a=1&b=2#frag' }, env: {},
    });
    expect(out).toMatchObject({ ok: true, envSets: { p: 'api.example.test|/v1/items|a=1&b=2|/v1/items?a=1&b=2' } });
    const q = await runScript({ code: `pm.request.url.query.add('a=1')`, req, env: {} });
    expect(q).toMatchObject({ ok: false, error: 'pm.request.url.query is not supported in JanusAPI scripts' });
  });

  it('fails a done-style test that does not call done synchronously', async () => {
    const out = await run(`pm.test('later', function (done) { }); pm.test('now', function (done) { done(); }); pm.test('err', function (done) { done(new Error('bad')); })`);
    expect(out.tests).toEqual([
      { name: 'later', passed: false, error: 'done() must be called synchronously; async tests are not supported' },
      { name: 'now', passed: true },
      { name: 'err', passed: false, error: 'bad' },
    ]);
  });
});

describe('pm review fixes: isolation allow-list', () => {
  const ALLOWED = [
    'AggregateError', 'Array', 'ArrayBuffer', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView', 'Date', 'Error',
    'EvalError', 'Float32Array', 'Float64Array', 'Function', 'Infinity', 'Int16Array', 'Int32Array', 'Int8Array', 'InternalError',
    'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set',
    'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'URIError', 'Uint16Array', 'Uint32Array', 'Uint8Array',
    'Uint8ClampedArray', 'WeakMap', 'WeakSet', 'chai', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape',
    'eval', 'globalThis', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'self', 'undefined', 'unescape',
  ];

  it.each([
    ['globalThis'],
    [`pm.constructor.constructor('return this')()`],
    [`pm.response.to.constructor.constructor('return this')()`],
    [`pm.cookies.constructor.constructor`],
  ])('the global reached through %s holds only ECMAScript built-ins and chai', async (expr) => {
    const out = await run(`
      let g = ${expr};
      if (typeof g === 'function') g = g('return this')();
      env.set('names', JSON.stringify(Object.getOwnPropertyNames(g).sort()));
      env.set('proto', String(Object.getPrototypeOf(g) === Object.prototype));
    `);
    expect(out.ok, out.error).toBe(true);
    expect(JSON.parse(out.envSets.names)).toEqual(ALLOWED);
    expect(out.envSets.proto).toBe('true');
  });
});

describe('iteration and pm.iterationData', () => {
  const iteration = { index: 3, count: 5, data: { email: 'alice@example.com', role: 'admin' } };

  it('exposes iteration { index, count, data } and pm.iterationData', async () => {
    const out = await runScript({
      code: `
        env.set('i', String(iteration.index));
        env.set('c', String(iteration.count));
        env.set('email', iteration.data.email);
        env.set('get', pm.iterationData.get('role'));
        env.set('has', String(pm.iterationData.has('role')) + String(pm.iterationData.has('missing')));
        env.set('obj', JSON.stringify(pm.iterationData.toObject()));
        env.set('missing', String(pm.iterationData.get('missing')));
        env.set('pmi', String(pm.info.iteration) + '/' + String(pm.info.iterationCount));
        env.set('replaced', pm.iterationData.replaceIn('{{role}}-{{nope}}'));`,
      req, env: { role: 'env-role' }, iteration,
    });
    expect(out.ok, out.error).toBe(true);
    expect(out.envSets).toEqual({
      i: '3', c: '5', email: 'alice@example.com', get: 'admin', has: 'truefalse', obj: '{"email":"alice@example.com","role":"admin"}',
      missing: 'undefined', pmi: '2/5', replaced: 'admin-{{nope}}',
    });
  });

  it('a single send sees iteration 0 with empty data', async () => {
    const out = await runScript({
      code: `env.set('s', JSON.stringify(iteration) + pm.info.iteration + pm.info.iterationCount + JSON.stringify(pm.iterationData.toObject()))`,
      req, env: {},
    });
    expect(out.envSets.s).toBe('{"index":0,"count":1,"data":{}}01{}');
  });

  it('iteration data is read-only for scripts', async () => {
    const out = await runScript({
      code: `
        'use strict';
        let threw = 0;
        try { iteration.data.email = 'x'; } catch (e) { threw++; }
        try { iteration.index = 9; } catch (e) { threw++; }
        try { pm.iterationData.toObject().email = 'y'; } catch (e) { threw++; }
        env.set('r', threw + ':' + iteration.data.email + ':' + iteration.index + ':' + pm.iterationData.get('email'));`,
      req, env: {}, iteration,
    });
    expect(out.ok, out.error).toBe(true);
    expect(out.envSets.r).toBe('2:alice@example.com:3:alice@example.com');
  });

  it('pm.iterationData.set and unset are refused with a named error', async () => {
    const out = await runScript({ code: `pm.iterationData.set('a', 'b')`, req, env: {}, iteration });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/pm\.iterationData\.set is not supported/);
  });
});
