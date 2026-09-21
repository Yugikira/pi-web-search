import test from 'node:test';
import assert from 'node:assert/strict';
import { callApiStream, getProviderKind } from '../src/api.ts';
import { createMockCtx as mockCtx } from './helpers.mjs';
import { makeResponse } from './fixtures.mjs';

test('getProviderKind identifies DeepSeek by provider and baseUrl', () => {
    assert.equal(getProviderKind({
        id: 'deepseek-chat',
        provider: 'deepseek',
        api: 'openai-chatcompletions',
        baseUrl: 'https://api.deepseek.com',
        maxTokens: 4096,
        headers: {},
    }), 'deepseek');

    assert.equal(getProviderKind({
        id: 'deepseek-reasoner',
        provider: 'custom-provider',
        api: 'openai-chatcompletions',
        baseUrl: 'https://api.deepseek.com/v1',
        maxTokens: 4096,
        headers: {},
    }), 'deepseek');
});

test('DeepSeek stream routes to Anthropic endpoint and handles server web search', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
        assert.equal(init.headers['x-api-key'], 'deepseek-key-123');
        assert.equal(init.headers['Authorization'], 'Bearer deepseek-key-123');
        // DeepSeek should NOT receive Claude Code OAuth headers
        assert.equal(init.headers['anthropic-beta'], undefined);
        assert.equal(init.headers['x-app'], undefined);

        const body = JSON.parse(init.body);
        assert.equal(body.model, 'deepseek-chat');
        assert.deepEqual(body.tools[0], { type: 'web_search_20250305', name: 'web_search', max_uses: 10 });

        return makeResponse([
            { data: { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'ds_call_1', name: 'web_search', input: { query: 'latest tech news' } } } },
            { data: { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'ds_call_1', content: [{ type: 'web_search_result', title: 'Tech News', url: 'https://news.example.com/tech', page_age: null }] } } },
            { data: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } },
            { data: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Here is the latest tech news.' } } },
            { data: { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', cited_text: 'latest tech news', title: 'Tech News', url: 'https://news.example.com/tech' } } } },
        ]);
    });

    const result = await callApiStream(mockCtx('deepseek-key-123'), {
        id: 'deepseek-chat',
        provider: 'deepseek',
        api: 'openai-chatcompletions',
        baseUrl: 'https://api.deepseek.com',
        maxTokens: 8192,
        headers: {},
    }, { contents: [{ parts: [{ text: 'latest tech news' }] }] });

    assert.equal(result.providerKind, 'deepseek');
    assert.equal(result.nativeSearchUsed, true);
    assert.deepEqual(result.searchQueries, ['latest tech news']);
    assert.equal(result.sources[0].url, 'https://news.example.com/tech');
    assert.equal(result.searchResults[0].url, 'https://news.example.com/tech');
});

test('DeepSeek stream falls back to DEEPSEEK_API_KEY when resolved auth has no credential', async (t) => {
    const prevKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'env-ds-key-456';

    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
        assert.equal(init.headers['x-api-key'], 'env-ds-key-456');
        assert.equal(init.headers['Authorization'], 'Bearer env-ds-key-456');
        return makeResponse([
            { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Auth accepted' } } },
        ]);
    });

    try {
        const result = await callApiStream(mockCtx(undefined), {
            id: 'deepseek-chat',
            provider: 'deepseek',
            api: 'openai-chatcompletions',
            baseUrl: 'https://api.deepseek.com',
            maxTokens: 4096,
            headers: {},
        }, { contents: [{ parts: [{ text: 'test query' }] }] });

        assert.equal(result.providerKind, 'deepseek');
        assert.equal(result.text, 'Auth accepted');
    } finally {
        process.env.DEEPSEEK_API_KEY = prevKey;
    }
});
