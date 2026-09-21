import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callApiStream, getProviderKind } from '../src/api.ts';
import { createModelScopedToolManager } from '../src/index.ts';
import {
    getAntigravityAuth,
    refreshAccessToken,
    callAntigravityGrounding,
    getAntigravityClientCredentials,
    SEARCH_MODEL,
} from '../src/providers/antigravity.ts';
import { urlContext } from '../src/url_context.ts';
import { createMockCtx as mockCtx } from './helpers.mjs';

test('getProviderKind identifies Antigravity models', () => {
    assert.equal(getProviderKind({
        id: 'gemini-3.8-flash',
        provider: 'antigravity',
        api: 'antigravity',
        baseUrl: 'https://cloudcode-pa.googleapis.com',
        maxTokens: 8192,
        headers: {},
    }), 'antigravity');

    assert.equal(getProviderKind({
        id: 'claude-3-7-sonnet',
        provider: 'antigravity',
        api: 'anthropic-messages',
        baseUrl: 'https://cloudcode-pa.googleapis.com',
        maxTokens: 8192,
        headers: {},
    }), 'antigravity');
});

test('model-scoped tool manager keeps url_context active for Antigravity models', () => {
    let active = ['web_search', 'url_context'];
    const pi = {
        getActiveTools: () => active,
        setActiveTools: (tools) => { active = tools; },
    };
    const manager = createModelScopedToolManager(pi);

    manager.sync({
        id: 'gemini-3.8-flash',
        provider: 'antigravity',
        api: 'antigravity',
        baseUrl: 'https://cloudcode-pa.googleapis.com',
        maxTokens: 8192,
        headers: {},
    });

    assert.deepEqual(active, ['web_search', 'url_context']);
});

test('Antigravity client credentials can be overridden via environment variables', () => {
    const prevId = process.env.ANTIGRAVITY_CLIENT_ID;
    const prevSecret = process.env.ANTIGRAVITY_CLIENT_SECRET;
    try {
        process.env.ANTIGRAVITY_CLIENT_ID = 'custom-client-id';
        process.env.ANTIGRAVITY_CLIENT_SECRET = 'custom-client-secret';

        const creds = getAntigravityClientCredentials();
        assert.equal(creds.clientId, 'custom-client-id');
        assert.equal(creds.clientSecret, 'custom-client-secret');
    } finally {
        if (prevId !== undefined) process.env.ANTIGRAVITY_CLIENT_ID = prevId;
        else delete process.env.ANTIGRAVITY_CLIENT_ID;
        if (prevSecret !== undefined) process.env.ANTIGRAVITY_CLIENT_SECRET = prevSecret;
        else delete process.env.ANTIGRAVITY_CLIENT_SECRET;
    }
});

test('refreshAccessToken throws helpful error when client credentials are missing', async () => {
    await assert.rejects(
        () => refreshAccessToken('test-token', { clientId: '', clientSecret: '' }),
        /Antigravity OAuth token is expired and cannot be refreshed/
    );
});

test('refreshAccessToken exchanges refresh token with Google OAuth server', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, 'https://oauth2.googleapis.com/token');
        assert.equal(init.method, 'POST');
        const body = new URLSearchParams(init.body);
        assert.equal(body.get('refresh_token'), 'test-refresh-token');
        assert.equal(body.get('grant_type'), 'refresh_token');

        return new Response(JSON.stringify({
            access_token: 'ya29.new-refreshed-token',
            expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const refreshed = await refreshAccessToken('test-refresh-token', {
        clientId: 'mock-client-id',
        clientSecret: 'mock-client-secret',
    });

    assert.equal(refreshed.accessToken, 'ya29.new-refreshed-token');
    assert.equal(refreshed.expiresIn, 3600);
});

test('Antigravity web_search sub-call sends googleSearch tool and gemini-2.5-flash to v1internal', async (t) => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pi-ag-auth-'));
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tempDir;

    await writeFile(join(tempDir, 'auth.json'), JSON.stringify({
        antigravity: {
            access: 'ya29.valid-access-token',
            expires: Date.now() + 3600_000,
            projectId: 'my-custom-project',
        }
    }));

    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.ok(url.includes('/v1internal:generateContent'));
        assert.equal(init.headers['Authorization'], 'Bearer ya29.valid-access-token');
        assert.ok(init.headers['User-Agent'].includes('antigravity/'));
        assert.ok(init.headers['X-Goog-Api-Client'].includes('vscode_cloudshelleditor'));
        assert.ok(init.headers['Client-Metadata'].includes('ANTIGRAVITY'));

        const body = JSON.parse(init.body);
        assert.equal(body.project, 'my-custom-project');
        assert.equal(body.model, SEARCH_MODEL); // gemini-2.5-flash
        assert.equal(body.userAgent, 'antigravity');
        assert.deepEqual(body.request.tools, [{ googleSearch: {} }]);
        assert.equal(body.request.contents[0].parts[0].text, 'test query');

        return new Response(JSON.stringify({
            candidates: [{
                content: {
                    parts: [{ text: 'Antigravity search result answer.' }]
                },
                groundingMetadata: {
                    webSearchQueries: ['test query'],
                    groundingChunks: [{ web: { uri: 'https://example.com/ag', title: 'Example Title' } }],
                    groundingSupports: [{
                        segment: { startIndex: 0, endIndex: 30 },
                        groundingChunkIndices: [0]
                    }]
                }
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    try {
        const result = await callApiStream(mockCtx(undefined), {
            id: 'claude-3-7-sonnet',
            provider: 'antigravity',
            api: 'antigravity',
            baseUrl: 'https://cloudcode-pa.googleapis.com',
            maxTokens: 4096,
            headers: {},
        }, { contents: [{ parts: [{ text: 'test query' }] }] });

        assert.equal(result.providerKind, 'antigravity');
        assert.equal(result.nativeSearchUsed, true);
        assert.deepEqual(result.searchQueries, ['test query']);
        assert.equal(result.sources[0].url, 'https://example.com/ag');
        assert.ok(result.text.includes('[1]'));
    } finally {
        if (prevAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevAgentDir;
        else delete process.env.PI_CODING_AGENT_DIR;
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('Antigravity url_context sends urlContext tool and URLs embedded in prompt text', async (t) => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pi-ag-auth-url-'));
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tempDir;

    await writeFile(join(tempDir, 'auth.json'), JSON.stringify({
        antigravity: {
            access: 'ya29.valid-url-token',
            expires: Date.now() + 3600_000,
            projectId: 'my-url-project',
        }
    }));

    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.ok(url.includes('/v1internal:generateContent'));
        const body = JSON.parse(init.body);
        assert.equal(body.project, 'my-url-project');
        assert.equal(body.model, SEARCH_MODEL); // gemini-2.5-flash
        assert.deepEqual(body.request.tools, [{ urlContext: {} }]);
        // Verify URLs are passed in the prompt text
        assert.ok(body.request.contents[0].parts[0].text.includes('https://doc.example.com'));
        assert.ok(body.request.contents[0].parts[0].text.includes('Analyze this page'));

        return new Response(JSON.stringify({
            candidates: [{
                content: {
                    parts: [{ text: 'Analyzed documentation content.' }]
                },
                urlContextMetadata: {
                    url_metadata: [{
                        retrieved_url: 'https://doc.example.com',
                        url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS'
                    }]
                }
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    try {
        const agModel = {
            id: 'gemini-3.8-flash',
            provider: 'antigravity',
            api: 'antigravity',
            baseUrl: 'https://cloudcode-pa.googleapis.com',
            maxTokens: 4096,
            headers: {},
        };

        const ctx = mockCtx(undefined, agModel);
        const result = await urlContext('call_1', {
            query: 'Analyze this page',
            urls: ['https://doc.example.com']
        }, new AbortController().signal, undefined, ctx);

        assert.equal(result.details.providerKind, 'antigravity');
        assert.ok(result.content[0].text.includes('Analyzed documentation content.'));
        assert.deepEqual(result.details.retrieved, ['https://doc.example.com']);
    } finally {
        if (prevAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevAgentDir;
        else delete process.env.PI_CODING_AGENT_DIR;
        await rm(tempDir, { recursive: true, force: true });
    }
});
