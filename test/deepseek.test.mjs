import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { askDeepSeek, schemaErrors, decideFund, FUND_TOOL, FUND_MODELS, MODELS, isDeepSeek, DEEPSEEK_URL, deepseekPeak } from '../ai.js';
import { newFund } from '../fund.js';

const prices = JSON.parse(await readFile(new URL('../data/sample-prices.json', import.meta.url), 'utf8'));
const tool = { name: 'submit', description: 'd', input_schema: { type: 'object', additionalProperties: false, required: ['a', 'items'], properties: { a: { type: 'number' }, items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['k', 'side'], properties: { k: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] } } } } } } };

// A stand-in for DeepSeek's chat API: answers in turn, keeping each request.
const fakeFetch = (...answers) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const a = answers.shift();
    if (a instanceof Error) throw a;
    if (typeof a === 'number') return { ok: false, status: a, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => a };
  };
  f.calls = calls;
  return f;
};
const answer = (args, usage = { prompt_tokens: 30000, prompt_cache_hit_tokens: 20000, prompt_cache_miss_tokens: 10000, completion_tokens: 500 }, finish = 'tool_calls') => ({
  model: 'deepseek-flash', usage,
  choices: [{ finish_reason: finish, message: { role: 'assistant', content: '', tool_calls: args == null ? undefined : [{ id: 'c1', type: 'function', function: { name: 'submit', arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] } }],
});

const offPeak = new Date('2026-09-28T12:00:00Z'); // a Monday, 20:00 in Singapore
const peak = new Date('2026-09-28T02:00:00Z'); // 10:00 in Singapore, SGX trading

test('askDeepSeek forces the tool with thinking off, reads the answer and prices it, peak hours at double', async () => {
  const fetchImpl = fakeFetch(answer({ a: 1, items: [{ k: 'x', side: 'buy' }] }));
  const res = await askDeepSeek({ apiKey: 'k', system: 'sys', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], tool, fetchImpl, now: offPeak });
  assert.deepEqual(res.input, { a: 1, items: [{ k: 'x', side: 'buy' }] });
  assert.equal(res.model, 'deepseek-flash');
  // Flash off-peak: 10k new input at 0.15, 20k cached at 0.003, 500 out at 0.60 per million
  assert.equal(res.usage.costUsd, 0.0019);
  const { url, init, body } = fetchImpl.calls[0];
  assert.equal(url, DEEPSEEK_URL);
  assert.equal(init.headers.Authorization, 'Bearer k');
  assert.equal(body.model, 'deepseek-flash');
  // thinking refuses a forced tool call (a probe of the API), so it's off
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'one\n\ntwo' }]);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'submit' } });
  assert.deepEqual(body.tools[0].function.parameters, tool.input_schema);
  // peak hours double every rate; Pro costs more
  assert.equal((await askDeepSeek({ apiKey: 'k', system: 's', content: 'c', tool, fetchImpl: fakeFetch(answer({ a: 1, items: [] })), now: peak })).usage.costUsd, 0.0037);
  const pro = fakeFetch(answer({ a: 1, items: [] }));
  const p = await askDeepSeek({ apiKey: 'k', model: 'deepseek-v4-pro', system: 's', content: 'c', tool, fetchImpl: pro, now: offPeak });
  assert.equal(pro.calls[0].body.model, 'deepseek-v4-pro');
  assert.equal(p.usage.costUsd, 0.008); // 6.6 + 0.44 + 0.99 thousandths of a dollar
  assert.deepEqual([deepseekPeak(peak), deepseekPeak(offPeak), deepseekPeak(new Date('2026-09-27T02:00:00Z'))], [true, false, false]); // not on a Sunday
});

test('askDeepSeek: one reminder when it answers without the tool; errors say why and carry what was billed', async () => {
  const noCall = answer(null, { prompt_tokens: 1000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000, completion_tokens: 100 }, 'stop');
  const twice = fakeFetch(noCall, answer({ a: 2, items: [] }));
  const res = await askDeepSeek({ apiKey: 'k', system: 's', content: 'c', tool, fetchImpl: twice });
  assert.equal(res.input.a, 2);
  assert.equal(twice.calls[1].body.messages.at(-1).content, 'Please call submit with your answer now.');
  assert.equal(res.usage.input, 11000);
  // never calling it: refused, with the cost of both answers
  await assert.rejects(askDeepSeek({ apiKey: 'k', system: 's', content: 'c', tool, fetchImpl: fakeFetch(noCall, noCall) }), (e) => /did not return an answer/.test(e.message) && e.usage.costUsd > 0);
  // small slips are repaired rather than costing the answer: a number sent as text is read as one, and
  // an item that can't be fixed (an unknown side, where the list has no 'other') is left out on its own
  const tidied = await askDeepSeek({ apiKey: 'k', system: 's', content: 'c', tool, fetchImpl: fakeFetch(answer({ a: '1', items: [{ k: 'x', side: 'hold' }, { k: 'y', side: 'sell' }] })) });
  assert.deepEqual(tidied.input, { a: 1, items: [{ k: 'y', side: 'sell' }] });
  assert.deepEqual(tidied.repaired, { fixed: 1, dropped: 1 });
  // a top-level field that can't be fixed still refuses it, with what was billed
  await assert.rejects(askDeepSeek({ apiKey: 'k', system: 's', content: 'c', tool, fetchImpl: fakeFetch(answer({ a: 'lots', items: [] })) }),
    (e) => /answer\.a doesn't fit/.test(e.message) && e.usage.costUsd > 0);
  await assert.rejects(askDeepSeek({ apiKey: 'k', system: 's', content: 'c', tool, fetchImpl: fakeFetch(answer('{not json')) }), /not in the expected format/);
  await assert.rejects(askDeepSeek({ apiKey: 'k', system: 's', content: 'c', tool, fetchImpl: fakeFetch(answer({ items: [] })) }), /answer\.a is missing/);
  await assert.rejects(askDeepSeek({ apiKey: 'k', system: 's', content: 'c', tool, fetchImpl: fakeFetch(answer({ a: 1, items: [] }, undefined, 'length')) }), /cut off/);
  // the account and the service: nothing billed
  for (const [status, why] of [[401, /rejected the API key/], [402, /no balance left/], [429, /Rate limited/], [503, /overloaded/], [500, /API error 500/]]) {
    await assert.rejects(askDeepSeek({ apiKey: 'k', system: 's', content: 'c', tool, fetchImpl: fakeFetch(status) }), (e) => why.test(e.message) && e.usage === undefined);
  }
  await assert.rejects(askDeepSeek({ apiKey: 'k', system: 's', content: 'c', tool, fetchImpl: fakeFetch(new TypeError('fetch failed')) }), /Could not reach DeepSeek/);
  // an empty body after a billed first answer: refused, still carrying what the first cost
  await assert.rejects(askDeepSeek({ apiKey: 'k', system: 's', content: 'c', tool, fetchImpl: fakeFetch(noCall, null) }), (e) => /could not be read/.test(e.message) && e.usage.costUsd > 0);
  await assert.rejects(askDeepSeek({ apiKey: '', system: 's', content: 'c', tool, fetchImpl: fakeFetch() }), /DEEPSEEK_API_KEY isn't set/);
});

test('the lenient check needs the top-level fields and right types, not the newer inner fields', () => {
  const s = FUND_TOOL.input_schema;
  const top = Object.fromEntries(s.required.map((k) => [k, s.properties[k].type === 'array' ? [] : s.properties[k].type === 'string' ? '' : 0]));
  assert.deepEqual(schemaErrors(s, top, 'answer', { lenient: true }), []);
  // an order with only the old fields passes; an unknown action doesn't
  const orderSchema = s.properties.orders.items;
  const old = { symbol: 'AAPL', action: orderSchema.properties.action.enum[0], shares: 5 };
  assert.deepEqual(schemaErrors(s, { ...top, orders: [old] }, 'answer', { lenient: true }), []);
  assert.match(schemaErrors(s, { ...top, orders: [{ ...old, action: 'yolo' }] }, 'answer', { lenient: true })[0], /orders\[0\]\.action isn't one of/);
  assert.match(schemaErrors(s, { ...top, orders: [{ ...old, shares: 'five' }] }, 'answer', { lenient: true })[0], /shares isn't a/);
  // the strict check (Claude's guarantee) wants every field
  assert.ok(schemaErrors(s, { ...top, orders: [old] }).length > 0);
});

test('a fund on DeepSeek decides through it, with news from Claude; the model is only offered for funds', async () => {
  assert.ok(isDeepSeek('deepseek-flash') && isDeepSeek('deepseek-v4-pro') && !isDeepSeek('claude-sonnet-5'));
  assert.ok(FUND_MODELS['deepseek-flash'] && !MODELS['deepseek-flash']); // not for the browser's strategist
  const fund = newFund({ budget: 10000, currency: 'USD', now: new Date('2026-01-02T15:00:00Z') });
  fund.settings.model = 'deepseek-flash';
  const news = { market_summary: 'm', items: [], model: 'claude-haiku-4-5', usage: { costUsd: 0.02 }, createdAt: 'x' };
  const client = { beta: { messages: { stream: () => { throw new Error('Claude must not be asked for the decision'); } } } };
  const decision = { outlook: 'Wait.', orders: [], considered: [], protections: [], source_urls: [] };
  const fetchImpl = fakeFetch({ ...answer(null), choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: FUND_TOOL.name, arguments: JSON.stringify({ ...Object.fromEntries(FUND_TOOL.input_schema.required.map((k) => [k, FUND_TOOL.input_schema.properties[k].type === 'array' ? [] : ''])), ...decision }) } }] } }] });
  const d = await decideFund({ client, fund, quotes: prices.quotes, news, model: 'deepseek-flash', cacheShared: true, deepseek: { apiKey: 'k', fetchImpl }, now: offPeak });
  assert.equal(d.outlook, 'Wait.');
  assert.equal(d.model, 'deepseek-flash');
  assert.equal(d.newsModel, 'claude-haiku-4-5');
  assert.equal(d.usage.costUsd, 0.0019); // the reused news isn't counted again
  const sent = fetchImpl.calls[0].body.messages[1].content;
  assert.match(sent, /^Market data as JSON/);
  assert.match(sent, /Decision time\. The fund's state as JSON/);
  // no key: a clear error before anything is sent
  await assert.rejects(decideFund({ client, fund, quotes: prices.quotes, news, model: 'deepseek-flash', deepseek: { apiKey: '' } }), /DEEPSEEK_API_KEY isn't set/);
});

// ---------- the opt-in news digest from the feeds ----------

import { gatherNews, digestFrom, NEWS_TOOL, FEED_DIGEST } from '../ai.js';
import { digestQuality } from '../articles.js';

const headlines = (n, now) => Array.from({ length: n }, (_, i) => ({
  id: `a${i}`, symbols: [i % 2 ? 'AAPL' : 'D05.SI'], source: i % 2 ? 'finance.yahoo.com' : 'businesstimes.com.sg', feed: 'x',
  pubDate: new Date(now.getTime() - (i + 1) * 3600000).toISOString(), headline: `Headline ${i}`, url: `https://example.com/${i}`,
}));
const claudeDigest = () => {
  const calls = [];
  return { calls, beta: { messages: { stream: (req) => { calls.push(req); return { finalMessage: async () => ({ stop_reason: 'tool_use', model: req.model, content: [{ type: 'tool_use', id: 't', name: NEWS_TOOL.name, input: { market_summary: 'From search.', items: [] } }], usage: { input_tokens: 1000, output_tokens: 100 } }) }; } } } };
};

test('Claude with web search stays the digest unless NEWS_DIGEST_MODEL asks for DeepSeek', () => {
  assert.equal(digestFrom({ DEEPSEEK_API_KEY: 'k' }), null);
  assert.equal(digestFrom({ NEWS_DIGEST_MODEL: 'deepseek-flash' }), null); // no key
  assert.equal(digestFrom({ NEWS_DIGEST_MODEL: 'deepseek-flash', DEEPSEEK_API_KEY: 'k', NEWS_LEADS: 'off' }), null); // no feeds
  assert.equal(digestFrom({ NEWS_DIGEST_MODEL: 'claude', DEEPSEEK_API_KEY: 'k' }), null);
  assert.deepEqual(digestFrom({ NEWS_DIGEST_MODEL: 'deepseek-flash', DEEPSEEK_API_KEY: 'k' }), { model: 'deepseek-flash', apiKey: 'k' });
});

test('the DeepSeek digest reads the feeds\' headlines, cites only their links, and falls back to Claude', async () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const articles = headlines(30, now);
  const items = [
    { symbols: ['AAPL', 'ZZZ'], date: '2026-09-28', headline: 'Apple news', summary: 's', type: 'product', tone: 'positive', source_url: 'https://example.com/1?utm_source=x' },
    { symbols: ['D05.SI'], date: '2026-09-28', headline: 'Made up', summary: 's', type: 'other', tone: 'mixed', source_url: 'https://elsewhere.com/x' },
  ];
  const fetchImpl = fakeFetch({ ...answer(null), choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: NEWS_TOOL.name, arguments: JSON.stringify({ market_summary: 'From the feeds.', items }) } }] } }] });
  const client = claudeDigest();
  const news = await gatherNews({ client, quotes: prices.quotes, now, articles, digest: { model: 'deepseek-flash', apiKey: 'k', fetchImpl } });
  assert.equal(client.calls.length, 0);
  assert.equal(news.via, 'feeds');
  assert.equal(news.model, 'deepseek-flash');
  assert.deepEqual(news.items.map((i) => [i.symbols, i.source_url]), [[['AAPL'], 'https://example.com/1'], [['D05.SI'], null]]);
  assert.equal(news.leads.length, 30);
  assert.ok(news.usage.costUsd > 0 && news.usage.searches === 0);
  const sent = fetchImpl.calls[0].body.messages[1].content;
  assert.match(sent, /Headlines from the news feeds, newest first:\n- \[AAPL\] Headline 0|Headline 1/);
  assert.deepEqual(digestQuality(news).via, 'feeds');
  // too few headlines (the feeds down): Claude searches as before
  const few = claudeDigest();
  const fallback = await gatherNews({ client: few, quotes: prices.quotes, now, articles: headlines(FEED_DIGEST.min - 1, now), digest: { model: 'deepseek-flash', apiKey: 'k', fetchImpl: fakeFetch() } });
  assert.equal(few.calls.length, 1);
  assert.equal(fallback.via, 'search');
  // DeepSeek failing after being billed: Claude searches, and both costs count
  const bad = fakeFetch({ ...answer(null), choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: NEWS_TOOL.name, arguments: '{oops' } }] } }] });
  const both = claudeDigest();
  const rescued = await gatherNews({ client: both, quotes: prices.quotes, now, articles, digest: { model: 'deepseek-flash', apiKey: 'k', fetchImpl: bad } });
  assert.equal(both.calls.length, 1);
  assert.equal(rescued.market_summary, 'From search.');
  assert.ok(rescued.usage.costUsd > 0.001 + 0.0015);
  // no digest asked for: Claude, whatever the articles
  const plain = claudeDigest();
  assert.equal((await gatherNews({ client: plain, quotes: prices.quotes, now, articles })).via, 'search');
});


test('the slip that cost a real decision: an idea of an unknown kind is kept as "other", a broken order is left out', async () => {
  const { repairAnswer } = await import('../ai.js');
  const top = { outlook: 'Hold.', orders: [], considered: [], protections: [], source_urls: [] };
  // what DeepSeek sent on 2026-09-28: an idea_type outside the list
  const r = repairAnswer(FUND_TOOL.input_schema, { ...top, considered: [{ symbol: 'D05.SI', stance: 'long', idea_type: 'dividend', why_not: 'Waiting.' }] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.considered[0].idea_type, 'other');
  assert.deepEqual([r.fixed, r.dropped], [1, 0]);
  // an order with an unknown action, or shares that aren't whole, is left out; the good one stays
  const o = repairAnswer(FUND_TOOL.input_schema, { ...top, orders: [{ symbol: 'AAPL', action: 'hodl', shares: 3 }, { symbol: 'MSFT', action: 'buy', shares: 2.5 }, { symbol: 'NVDA', action: 'buy', shares: '4' }] });
  assert.deepEqual(o.value.orders, [{ symbol: 'NVDA', action: 'buy', shares: 4 }]);
  assert.deepEqual([o.fixed, o.dropped], [1, 2]);
  // the decision itself missing: refused
  assert.deepEqual(repairAnswer(FUND_TOOL.input_schema, { orders: [] }).errors.slice(0, 1), ['answer.outlook is missing']);
  assert.deepEqual(repairAnswer(FUND_TOOL.input_schema, 'hold').errors, ["the answer isn't an object"]);
});
