import test from 'node:test';
import assert from 'node:assert/strict';
import { isExaConfigured, resolveExaConfig, searchExa } from '../src/providers/exa.ts';
import { webSearch } from '../src/web_search.ts';
import { getProviderKind } from '../src/api.ts';
import { createModelScopedToolManager } from '../src/index.ts';
import { createMockCtx as mockCtx } from './helpers.mjs';

test('Exa config resolves from EXA_API_KEY environment variable', () => {
    const prevKey = process.env.EXA_API_KEY;
    try {
        process.env.EXA_API_KEY = 'exa-test-key-999';
        assert.equal(isExaConfigured(), true);
        const config = resolveExaConfig();
        assert.equal(config?.apiKey, 'exa-test-key-999');
        assert.equal(config?.baseUrl, 'https://api.exa.ai');
    } finally {
        if (prevKey !== undefined) process.env.EXA_API_KEY = prevKey;
        else delete process.env.EXA_API_KEY;
    }
});

test('searchExa sends POST to /search and formats results', async (t) => {
    const prevKey = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = 'exa-test-key-123';

    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, 'https://api.exa.ai/search');
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-api-key'], 'exa-test-key-123');
        assert.equal(init.headers['Content-Type'], 'application/json');

        const body = JSON.parse(init.body);
        assert.equal(body.query, 'what is antigravity');
        assert.equal(body.numResults, 8);

        return new Response(JSON.stringify({
            results: [
                {
                    title: 'Antigravity Concept',
                    url: 'https://example.com/antigravity',
                    snippet: 'Antigravity is a hypothetical phenomenon of creating a place or object that is free from the force of gravity.',
                },
                {
                    title: 'Theoretical Physics',
                    url: 'https://example.com/physics',
                    text: 'Full page text that should be sliced if no snippet.',
                }
            ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    try {
        const result = await searchExa('what is antigravity');
        assert.equal(result.providerKind, 'exa');
        assert.equal(result.nativeSearchUsed, true);
        assert.equal(result.sources?.length, 2);
        assert.equal(result.sources[0].title, 'Antigravity Concept');
        assert.equal(result.sources[0].url, 'https://example.com/antigravity');
        assert.ok(result.text.includes('## Search Results (Exa)'));
        assert.ok(result.text.includes('Antigravity Concept'));
    } finally {
        if (prevKey !== undefined) process.env.EXA_API_KEY = prevKey;
        else delete process.env.EXA_API_KEY;
    }
});

test('webSearch falls back to Exa when model is unsupported and Exa is configured', async (t) => {
    const prevKey = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = 'exa-fallback-key';

    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, 'https://api.exa.ai/search');
        assert.equal(init.headers['x-api-key'], 'exa-fallback-key');

        return new Response(JSON.stringify({
            results: [{
                title: 'Fallback Result',
                url: 'https://fallback.example.com',
                snippet: 'Exa fallback snippet.',
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    try {
        const unsupportedModel = {
            id: 'custom-unsupported-model',
            provider: 'custom-unsupported-provider',
            api: 'openai-chatcompletions',
            baseUrl: 'https://my-custom-endpoint.test/v1',
            maxTokens: 4096,
            headers: {},
        };

        const ctx = mockCtx(undefined, unsupportedModel);
        const result = await webSearch('call_fallback', {
            query: 'search with fallback'
        }, new AbortController().signal, undefined, ctx);

        assert.equal(result.details.providerKind, 'exa');
        assert.equal(result.details.sources[0].url, 'https://fallback.example.com');
        assert.ok(result.content[0].text.includes('Fallback Result'));
    } finally {
        if (prevKey !== undefined) process.env.EXA_API_KEY = prevKey;
        else delete process.env.EXA_API_KEY;
    }
});

test('webSearch reports unsupported model error when Exa is NOT configured', async () => {
    const prevKey = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;

    try {
        const unsupportedModel = {
            id: 'custom-unsupported-model',
            provider: 'custom-unsupported-provider',
            api: 'openai-chatcompletions',
            baseUrl: 'https://my-custom-endpoint.test/v1',
            maxTokens: 4096,
            headers: {},
        };

        const ctx = mockCtx(undefined, unsupportedModel);
        const result = await webSearch('call_fail', {
            query: 'search fails'
        }, new AbortController().signal, undefined, ctx);

        assert.equal(result.details.error, 'unsupported_model');
        assert.ok(result.content[0].text.includes('does not support native web search'));
    } finally {
        if (prevKey !== undefined) process.env.EXA_API_KEY = prevKey;
    }
});

test('unsupported models keep url_context suppressed even if Exa is configured', () => {
    const prevKey = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = 'some-key';

    let active = ['web_search', 'url_context'];
    const pi = {
        getActiveTools: () => active,
        setActiveTools: (tools) => { active = tools; },
    };
    const manager = createModelScopedToolManager(pi);

    const unsupportedModel = {
        id: 'custom-unsupported-model',
        provider: 'custom-unsupported-provider',
        api: 'openai-chatcompletions',
        baseUrl: 'https://my-custom-endpoint.test/v1',
        maxTokens: 4096,
        headers: {},
    };

    assert.equal(getProviderKind(unsupportedModel), 'unsupported');
    manager.sync(unsupportedModel);

    // url_context must be removed
    assert.deepEqual(active, ['web_search']);

    if (prevKey !== undefined) process.env.EXA_API_KEY = prevKey;
    else delete process.env.EXA_API_KEY;
});
