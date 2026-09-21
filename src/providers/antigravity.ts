import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
    applyCitations,
    extractGoogleSearchDetails,
    resolveGoogleGroundingRedirectUrls,
} from "./google.ts";
import { deriveSources, sanitizeSearchResults } from "./results.ts";
import type { StreamResult } from "./types.ts";

export const ANTIGRAVITY_CLIENT_ID: string | null = null;
export const ANTIGRAVITY_CLIENT_SECRET: string | null = null;
export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const SEARCH_MODEL = "gemini-2.5-flash";
export const DEFAULT_PROJECT_ID = "rising-fact-p41fc";

export interface AntigravityAuthEntry {
    type?: string;
    access?: string;
    refresh?: string;
    expires?: number;
    projectId?: string;
    email?: string;
    clientId?: string;
    clientSecret?: string;
}

export interface AntigravityAuthData {
    antigravity?: AntigravityAuthEntry;
    [key: string]: any;
}

export function readStoredConfig(): any {
    const candidatePaths = [
        path.join(getAgentDir(), "web-search.json"),
        path.join(os.homedir(), ".pi", "agent", "web-search.json"),
        path.join(os.homedir(), ".pi", "web-search.json"),
    ];

    for (const p of candidatePaths) {
        try {
            if (fs.existsSync(p)) {
                return JSON.parse(fs.readFileSync(p, "utf-8"));
            }
        } catch {
            // Ignore error and continue
        }
    }
    return {};
}

export function getAntigravityClientCredentials(): { clientId?: string | null; clientSecret?: string | null } {
    const config = readStoredConfig();
    const authData = readAuthData();
    const clientId = process.env.ANTIGRAVITY_CLIENT_ID?.trim()
        || config?.antigravity?.clientId?.trim()
        || authData?.antigravity?.clientId?.trim()
        || ANTIGRAVITY_CLIENT_ID;
    const clientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET?.trim()
        || config?.antigravity?.clientSecret?.trim()
        || authData?.antigravity?.clientSecret?.trim()
        || ANTIGRAVITY_CLIENT_SECRET;
    return { clientId, clientSecret };
}

export function getAuthFilePath(): string {
    const primary = path.join(getAgentDir(), "auth.json");
    if (fs.existsSync(primary)) return primary;
    const fallback = path.join(os.homedir(), ".pi", "agent", "auth.json");
    if (fs.existsSync(fallback)) return fallback;
    return primary;
}

export function readAuthData(): AntigravityAuthData {
    const filePath = getAuthFilePath();
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, "utf-8");
            return JSON.parse(raw);
        }
    } catch {
        // Ignore read errors
    }
    return {};
}

export function writeAuthData(data: AntigravityAuthData): void {
    const filePath = getAuthFilePath();
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, {
            encoding: "utf-8",
            mode: 0o600
        });
    } catch {
        // Ignore write errors
    }
}

export function isTokenFresh(expires?: number): boolean {
    if (!expires) return true;
    const ms = expires > 1e12 ? expires : expires * 1000;
    return ms > Date.now() + 60_000;
}

export async function refreshAccessToken(
    refreshToken: string,
    credentials = getAntigravityClientCredentials()
): Promise<{ accessToken: string; expiresIn: number }> {
    if (!credentials.clientId || !credentials.clientSecret) {
        throw new Error(
            "Antigravity OAuth token is expired and cannot be refreshed because Google OAuth client credentials " +
            "are not configured. Please set ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET environment variables, " +
            "or configure clientId and clientSecret in ~/.pi/agent/web-search.json. See README.md for details."
        );
    }

    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`Google OAuth token refresh failed (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    if (!data.access_token) {
        throw new Error("Google OAuth token refresh did not return an access token");
    }

    return {
        accessToken: data.access_token,
        expiresIn: typeof data.expires_in === "number" ? data.expires_in : 3600,
    };
}

export async function getAntigravityAuth(
    ctx?: ExtensionContext,
    model?: Model<Api>
): Promise<{ accessToken: string; projectId: string }> {
    // 1. Try ctx.modelRegistry if available
    if (ctx && model) {
        try {
            const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
            if (resolved.ok && resolved.apiKey && resolved.apiKey.startsWith("ya29.")) {
                const authData = readAuthData();
                const projectId = authData.antigravity?.projectId || DEFAULT_PROJECT_ID;
                return { accessToken: resolved.apiKey, projectId };
            }
        } catch {
            // Fall through to auth.json
        }
    }

    // 2. Read ~/.pi/agent/auth.json
    const authData = readAuthData();
    const entry = authData.antigravity;
    let accessToken = entry?.access?.trim();
    const refreshToken = entry?.refresh?.trim();
    let projectId = entry?.projectId?.trim() || DEFAULT_PROJECT_ID;

    if (accessToken && isTokenFresh(entry?.expires)) {
        return { accessToken, projectId };
    }

    if (refreshToken) {
        try {
            const refreshed = await refreshAccessToken(refreshToken);
            accessToken = refreshed.accessToken;
            if (authData.antigravity) {
                authData.antigravity.access = accessToken;
                authData.antigravity.expires = Date.now() + refreshed.expiresIn * 1000;
                writeAuthData(authData);
            }
            return { accessToken, projectId };
        } catch (err: any) {
            if (accessToken) {
                // If refresh fails but we still have an access token, attempt to use it
                return { accessToken, projectId };
            }
            throw new Error(`Antigravity token expired and refresh failed: ${err.message}. Please run /login antigravity in Pi.`);
        }
    }

    if (accessToken) {
        return { accessToken, projectId };
    }

    throw new Error("Antigravity credentials not found in ~/.pi/agent/auth.json. Please run /login antigravity in Pi to authenticate.");
}

export function getAntigravityHeaders(token: string): Record<string, string> {
    const platform = process.platform === "win32" ? "WINDOWS" : process.platform === "darwin" ? "MACOS" : "LINUX";
    const osType = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": `antigravity/1.18.3 ${osType}/${arch}`,
        "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY", platform, pluginType: "GEMINI" })
    };
}

export interface CallAntigravityGroundingOptions {
    ctx: ExtensionContext;
    model: Model<Api>;
    prompt: string;
    mode: "search" | "url_context";
    urls?: string[];
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
}

export async function callAntigravityGrounding(options: CallAntigravityGroundingOptions): Promise<StreamResult> {
    const { ctx, model, prompt, mode, urls, signal, onUpdate } = options;
    const { accessToken, projectId } = await getAntigravityAuth(ctx, model);

    const hasUrls = urls && urls.length > 0;
    let tools: any[];
    let finalPrompt: string;

    if (mode === "url_context") {
        tools = [{ urlContext: {} }];
        finalPrompt = hasUrls ? `${prompt}\n\nURLs to analyze:\n${urls!.join("\n")}` : prompt;
    } else {
        tools = [{ googleSearch: {} }];
        if (hasUrls) {
            tools.push({ urlContext: {} });
            finalPrompt = `${prompt}\n\nURLs to analyze:\n${urls!.join("\n")}`;
        } else {
            finalPrompt = prompt;
        }
    }

    const payload = {
        project: projectId,
        model: SEARCH_MODEL,
        userAgent: "antigravity",
        requestId: `search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        request: {
            contents: [{ role: "user", parts: [{ text: finalPrompt }] }],
            tools,
            generationConfig: {
                temperature: 0,
                topP: 1
            }
        }
    };

    const headers = getAntigravityHeaders(accessToken);
    const endpoints = [
        `${ANTIGRAVITY_ENDPOINT_PROD}/v1internal:generateContent`,
        `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:generateContent`
    ];

    let lastError: Error | undefined;
    let data: any;

    for (const url of endpoints) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
                signal: signal ?? AbortSignal.timeout(60_000)
            });

            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`API error (${res.status} ${res.statusText}): ${text}`);
            }

            data = await res.json();
            break;
        } catch (err: any) {
            lastError = err;
            if (signal?.aborted) throw err;
            // Retry on fallback endpoint
        }
    }

    if (!data) {
        throw lastError || new Error("Failed to contact Antigravity grounding endpoint");
    }

    const response = data.response || data;
    const candidate = response.candidates?.[0];
    if (!candidate) {
        const errMsg = data.error?.message || response.error?.message || "No candidate returned from Antigravity grounding API";
        throw new Error(errMsg);
    }

    const parts = candidate.content?.parts || [];
    let text = parts.map((p: any) => p.text || "").filter(Boolean).join("\n") || "No answer available.";

    onUpdate?.({
        content: [{ type: "text", text }],
        details: { streaming: false }
    });

    const groundingMetadata = candidate.groundingMetadata;
    const urlContextMetadata = candidate.urlContextMetadata || candidate.url_context_metadata;

    const searchDetails = extractGoogleSearchDetails(groundingMetadata);
    await resolveGoogleGroundingRedirectUrls(searchDetails.searchResults, searchDetails.citations, signal);

    const searchResults = sanitizeSearchResults(searchDetails.searchResults);
    const citations = sanitizeSearchResults(searchDetails.citations);
    const cited = applyCitations(text, groundingMetadata);

    return {
        text: cited.text,
        sources: cited.sources.length ? cited.sources : deriveSources(searchResults, citations),
        providerKind: "antigravity",
        nativeSearchUsed: searchDetails.searchQueries.length > 0 || searchResults.length > 0 || citations.length > 0,
        nativeSearchEvents: searchDetails.searchQueries.length > 0 ? ["antigravity.groundingMetadata.webSearchQueries"] : [],
        searchQueries: searchDetails.searchQueries,
        searchResults,
        citations,
        groundingMetadata,
        urlContextMetadata
    };
}
