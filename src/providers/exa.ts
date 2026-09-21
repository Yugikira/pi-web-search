import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SearchResultDetail, Source, StreamResult } from "./types.ts";

export const DEFAULT_EXA_API_URL = "https://api.exa.ai";
const DEFAULT_TIMEOUT_MS = 60_000;
const EXA_MAX_SNIPPET_CHARS = 400;

export interface ExaConfig {
    apiKey: string;
    baseUrl: string;
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
            // Ignore error
        }
    }
    return {};
}

export function resolveExaConfig(): ExaConfig | undefined {
    const envKey = process.env.EXA_API_KEY?.trim();
    const config = readStoredConfig();
    const fileKey = config?.exa?.apiKey?.trim() || config?.exaApiKey?.trim();
    const apiKey = envKey || fileKey;
    if (!apiKey) return undefined;

    const baseUrl = process.env.EXA_BASE_URL?.trim() || config?.exa?.baseUrl?.trim() || DEFAULT_EXA_API_URL;
    return { apiKey, baseUrl };
}

export function isExaConfigured(): boolean {
    return Boolean(resolveExaConfig());
}

interface ExaApiResultItem {
    id?: string;
    url?: string;
    title?: string;
    text?: string;
    highlights?: string[];
    snippet?: string;
}

interface ExaApiResponse {
    results?: ExaApiResultItem[];
}

export async function searchExa(
    query: string,
    signal?: AbortSignal,
    options: { numResults?: number } = {}
): Promise<StreamResult> {
    const config = resolveExaConfig();
    if (!config) {
        throw new Error("Exa API key not found. Set EXA_API_KEY environment variable or configure in web-search.json");
    }

    const searchUrl = `${config.baseUrl.replace(/\/+$/, "")}/search`;
    const numResults = options.numResults && options.numResults > 0 ? options.numResults : 8;

    const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const body = {
        query,
        numResults,
        contents: {
            text: {
                maxCharacters: EXA_MAX_SNIPPET_CHARS,
            },
        },
    };

    const res = await fetch(searchUrl, {
        method: "POST",
        headers: {
            "x-api-key": config.apiKey,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
    });

    if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        throw new Error(`Exa search failed (${res.status} ${res.statusText}): ${errorText.slice(0, 300)}`);
    }

    const data = (await res.json()) as ExaApiResponse;
    const rawResults = Array.isArray(data.results) ? data.results : [];

    const sources: Source[] = [];
    const searchResults: SearchResultDetail[] = [];
    const lines: string[] = [];

    rawResults.forEach((item, index) => {
        const url = item.url || item.id || "";
        if (!url) return;
        const title = item.title || url;
        const snippet = item.highlights?.join(" ... ") || item.snippet || item.text?.slice(0, EXA_MAX_SNIPPET_CHARS) || "";

        sources.push({ title, url });
        searchResults.push({
            title,
            url,
            source: "exa.search",
            type: "web",
            raw: item,
        });

        lines.push(`${index + 1}. [${title}](${url})`);
        if (snippet) {
            lines.push(`   ${snippet}`);
        }
    });

    const text = lines.length > 0
        ? `## Search Results (Exa)\n\n${lines.join("\n")}`
        : `No search results found for: "${query}" via Exa.`;

    return {
        text,
        sources,
        providerKind: "exa",
        nativeSearchUsed: true,
        nativeSearchEvents: ["exa.search"],
        searchQueries: [query],
        searchResults,
    };
}
