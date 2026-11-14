// SANDBOX-ONLY helper: runs the unit tests on node:test when Jest cannot be installed (no network).
// Implements just the Jest subset the unit tests use. NOT part of the shipped test suite; real runs use `npm test`.
const nodeTest = require('node:test');
const assert = require('node:assert');
const util = require('node:util');

const fmt = (v) => util.inspect(v, { depth: 3 });
function matchers(actual, negate, mode) {
  const pass = (ok, msg) => { if (negate ? ok : !ok) throw new assert.AssertionError({ message: (negate ? 'NOT ' : '') + msg }); };
  const subset = (a, e) => e !== null && typeof e === 'object'
    ? a !== null && typeof a === 'object' && Object.keys(e).every((k) => subset(a[k], e[k]))
    : util.isDeepStrictEqual(a, e);
  const base = {
    toBe: (e) => pass(Object.is(actual, e), `expected ${fmt(actual)} toBe ${fmt(e)}`),
    toEqual: (e) => pass(util.isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(e))), `expected ${fmt(actual)} toEqual ${fmt(e)}`),
    toBeNull: () => pass(actual === null, `expected ${fmt(actual)} toBeNull`),
    toBeUndefined: () => pass(actual === undefined, `expected ${fmt(actual)} toBeUndefined`),
    toBeTruthy: () => pass(!!actual, `expected ${fmt(actual)} truthy`),
    toBeFalsy: () => pass(!actual, `expected ${fmt(actual)} falsy`),
    toBeGreaterThan: (e) => pass(actual > e, `expected ${actual} > ${e}`),
    toBeGreaterThanOrEqual: (e) => pass(actual >= e, `expected ${actual} >= ${e}`),
    toBeLessThan: (e) => pass(actual < e, `expected ${actual} < ${e}`),
    toBeCloseTo: (e, d = 2) => pass(Math.abs(actual - e) < Math.pow(10, -d) / 2, `expected ${actual} close to ${e}`),
    toContain: (e) => pass(actual.includes(e), `expected ${fmt(actual)} to contain ${fmt(e)}`),
    toHaveLength: (n) => pass(actual.length === n, `expected length ${actual.length} toBe ${n}`),
    toMatch: (re) => pass(re.test(actual), `expected ${fmt(actual)} toMatch ${re}`),
    toMatchObject: (e) => pass(subset(actual, e), `expected ${fmt(actual)} toMatchObject ${fmt(e)}`),
    toBeInstanceOf: (c) => pass(actual instanceof c, `expected instance of ${c.name}`),
    toThrow: (re) => {
      let threw = false, err;
      try { actual(); } catch (e) { threw = true; err = e; }
      pass(threw && (!re || (re instanceof RegExp ? re.test(String(err && err.message)) : err instanceof re)), `expected function to throw ${re ?? ''} (got ${fmt(err)})`);
    },
  };
  if (mode === 'resolves') return Object.fromEntries(Object.entries(base).map(([k, f]) => [k, async (...a) => matchers(await actual, negate)[k](...a)]));
  if (mode === 'rejects') return Object.fromEntries(Object.entries(base).map(([k, f]) => [k, async (...a) => {
    let err, threw = false; try { await actual; } catch (e) { threw = true; err = e; }
    if (!threw) throw new assert.AssertionError({ message: 'expected promise to reject' });
    if (k === 'toThrow') return matchers(() => { throw err; }, negate).toThrow(...a);
    return matchers(err, negate)[k](...a);
  }]));
  return base;
}
const expect = (actual) => ({ ...matchers(actual, false), not: matchers(actual, true), resolves: matchers(actual, false, 'resolves'), rejects: matchers(actual, false, 'rejects') });

const wrap = (fn) => (fn.length ? (_t, done) => fn(done) : () => fn());
const it = (name, fn) => nodeTest.it(name, wrap(fn));
it.each = (rows) => (name, fn) => rows.forEach((row, i) => {
  const args = Array.isArray(row) ? row : [row];
  const title = name.replace(/%s/g, () => String(args.shift ? args[0] : '')).replace(/%#/g, String(i));
  nodeTest.it(title.includes('%') ? name : title, () => fn(...(Array.isArray(row) ? row : [row])));
});
Object.assign(globalThis, { describe: nodeTest.describe, it, test: it, expect, beforeEach: nodeTest.beforeEach, afterEach: nodeTest.afterEach, beforeAll: nodeTest.before, afterAll: nodeTest.after });
