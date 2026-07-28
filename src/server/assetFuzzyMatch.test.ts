import http from "node:http";
import { describe, expect, it } from "vitest";
import type { AssetSourceCandidate } from "./assetSourceProviders";
import {
  buildFuzzyJudgmentPrompt,
  judgeFuzzyMatch,
  parseFuzzyJudgmentResponse,
  verifyFilenameInHfManifest,
  verifyUrlReachable,
  type FreeformSessionRunner
} from "./assetFuzzyMatch";

async function withTestServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unexpected test server address");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function makeCandidate(overrides: Partial<AssetSourceCandidate> = {}): AssetSourceCandidate {
  return {
    provider: "huggingface",
    title: "SeeSee21/Z-Image-Turbo-AIO",
    url: "https://huggingface.co/SeeSee21/Z-Image-Turbo-AIO",
    apiUrl: "https://huggingface.co/api/models?search=z-image-turbo-aio",
    score: 42,
    requiresToken: false,
    notes: "HuggingFace model search result",
    ...overrides
  };
}

describe("buildFuzzyJudgmentPrompt", () => {
  it("includes the requested filename and every candidate with its index", () => {
    const prompt = buildFuzzyJudgmentPrompt({
      requestedName: "Z-Image-Anime-AIO-FP8_V1.safetensors",
      candidates: [makeCandidate(), makeCandidate({ title: "Other/Repo", url: "https://huggingface.co/Other/Repo" })]
    });
    expect(prompt).toContain("Z-Image-Anime-AIO-FP8_V1.safetensors");
    expect(prompt).toContain("0. [huggingface] SeeSee21/Z-Image-Turbo-AIO");
    expect(prompt).toContain("1. [huggingface] Other/Repo");
  });

  it("says nothing was found when the candidate list is empty", () => {
    const prompt = buildFuzzyJudgmentPrompt({ requestedName: "missing.safetensors", candidates: [] });
    expect(prompt).toContain("structured keyword search found nothing");
  });

  it("mentions web_search/web_fetch tool usage and the JSON response contract", () => {
    const prompt = buildFuzzyJudgmentPrompt({ requestedName: "x.safetensors", candidates: [] });
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("matchedCandidateIndex");
    expect(prompt).toContain("confidence");
  });
});

describe("parseFuzzyJudgmentResponse", () => {
  it("parses a valid high-confidence judgment referencing a candidate index", () => {
    const response = `I searched and confirmed this.\n{"matchedCandidateIndex": 0, "confidence": "high", "reason": "same author and matching file size"}`;
    const result = parseFuzzyJudgmentResponse(response, 2);
    expect(result).toEqual({
      matchedCandidateIndex: 0,
      confidence: "high",
      reason: "same author and matching file size",
      suggestedUrl: undefined
    });
  });

  it("parses a judgment that found the real source outside the candidate list (matchedCandidateIndex null, suggestedUrl set)", () => {
    const response = `{"matchedCandidateIndex": null, "confidence": "medium", "reason": "found via web search, matching repo naming", "suggestedUrl": "https://huggingface.co/SeeSee21/Z-Image-Turbo-AIO"}`;
    const result = parseFuzzyJudgmentResponse(response, 0);
    expect(result?.matchedCandidateIndex).toBeNull();
    expect(result?.suggestedUrl).toBe("https://huggingface.co/SeeSee21/Z-Image-Turbo-AIO");
  });

  it("takes the LAST JSON object when the model narrates before answering", () => {
    const response = [
      "Let me think about this. {\"note\": \"scratch thought, ignore\"}",
      "Final answer:",
      '{"matchedCandidateIndex": 1, "confidence": "low", "reason": "weak genre similarity only"}'
    ].join("\n");
    const result = parseFuzzyJudgmentResponse(response, 2);
    expect(result?.matchedCandidateIndex).toBe(1);
    expect(result?.confidence).toBe("low");
  });

  it("returns undefined for a response with no JSON object at all", () => {
    expect(parseFuzzyJudgmentResponse("I could not find anything definitive.", 2)).toBeUndefined();
  });

  it("returns undefined for malformed JSON rather than guessing", () => {
    expect(parseFuzzyJudgmentResponse('{"confidence": "high", "reason": }', 2)).toBeUndefined();
  });

  it("returns undefined when confidence is missing or not one of the allowed values", () => {
    expect(parseFuzzyJudgmentResponse('{"matchedCandidateIndex": 0, "confidence": "certain"}', 2)).toBeUndefined();
    expect(parseFuzzyJudgmentResponse('{"matchedCandidateIndex": 0}', 2)).toBeUndefined();
  });

  it("returns undefined when matchedCandidateIndex is out of range (fails safe instead of pointing at the wrong candidate)", () => {
    expect(parseFuzzyJudgmentResponse('{"matchedCandidateIndex": 5, "confidence": "high", "reason": "x"}', 2)).toBeUndefined();
    expect(parseFuzzyJudgmentResponse('{"matchedCandidateIndex": -1, "confidence": "high", "reason": "x"}', 2)).toBeUndefined();
  });

  it("returns undefined when matchedCandidateIndex is a non-integer or wrong type", () => {
    expect(parseFuzzyJudgmentResponse('{"matchedCandidateIndex": 1.5, "confidence": "high", "reason": "x"}', 2)).toBeUndefined();
    expect(parseFuzzyJudgmentResponse('{"matchedCandidateIndex": "0", "confidence": "high", "reason": "x"}', 2)).toBeUndefined();
  });

  it("defaults reason to an empty string and suggestedUrl to undefined when absent", () => {
    const result = parseFuzzyJudgmentResponse('{"matchedCandidateIndex": null, "confidence": "none"}', 0);
    expect(result).toEqual({ matchedCandidateIndex: null, confidence: "none", reason: "", suggestedUrl: undefined });
  });
});

describe("judgeFuzzyMatch", () => {
  it("builds the prompt, calls the runner, and parses its final answer", async () => {
    const calls: Array<{ cwd: string; prompt: string; sessionId: string }> = [];
    const stubRunner: FreeformSessionRunner = {
      async runFreeformSession(input) {
        calls.push({ cwd: input.cwd, prompt: input.prompt, sessionId: input.sessionId });
        return {
          sessionId: input.sessionId,
          summary: '{"matchedCandidateIndex": 0, "confidence": "high", "reason": "matching author and strength range"}'
        };
      }
    };

    const result = await judgeFuzzyMatch({
      requestedName: "Klein-大熊一致性consistency（0.4-1.0）.safetensors",
      candidates: [makeCandidate({ title: "dx8152/Flux2-Klein-9B-Consistency" })],
      runner: stubRunner,
      cwd: "/tmp/whatever",
      sessionId: "test-session"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("Klein-大熊一致性consistency（0.4-1.0）");
    expect(result).toEqual({
      matchedCandidateIndex: 0,
      confidence: "high",
      reason: "matching author and strength range",
      suggestedUrl: undefined
    });
  });

  it("returns undefined when the session produces no summary at all", async () => {
    const stubRunner: FreeformSessionRunner = {
      async runFreeformSession(input) {
        return { sessionId: input.sessionId, summary: undefined };
      }
    };
    const result = await judgeFuzzyMatch({
      requestedName: "x.safetensors",
      candidates: [],
      runner: stubRunner,
      cwd: "/tmp",
      sessionId: "s"
    });
    expect(result).toBeUndefined();
  });

  it("verifies suggestedUrl reachability and attaches the result to the judgment", async () => {
    await withTestServer(
      (req, res) => {
        res.writeHead(200);
        res.end();
      },
      async (baseUrl) => {
        const stubRunner: FreeformSessionRunner = {
          async runFreeformSession(input) {
            return {
              sessionId: input.sessionId,
              summary: `{"matchedCandidateIndex": null, "confidence": "medium", "reason": "found via search", "suggestedUrl": "${baseUrl}/model.safetensors"}`
            };
          }
        };
        const result = await judgeFuzzyMatch({
          requestedName: "x.safetensors",
          candidates: [],
          runner: stubRunner,
          cwd: "/tmp",
          sessionId: "s"
        });
        expect(result?.urlVerified).toBe(true);
        expect(result?.urlVerifiedDetail).toBe("HTTP 200");
      }
    );
  });

  it("flags a suggestedUrl that doesn't actually resolve, without dropping the judgment", async () => {
    await withTestServer(
      (req, res) => {
        res.writeHead(404);
        res.end();
      },
      async (baseUrl) => {
        const stubRunner: FreeformSessionRunner = {
          async runFreeformSession(input) {
            return {
              sessionId: input.sessionId,
              summary: `{"matchedCandidateIndex": null, "confidence": "medium", "reason": "found via search", "suggestedUrl": "${baseUrl}/does-not-exist.safetensors"}`
            };
          }
        };
        const result = await judgeFuzzyMatch({
          requestedName: "x.safetensors",
          candidates: [],
          runner: stubRunner,
          cwd: "/tmp",
          sessionId: "s"
        });
        expect(result?.confidence).toBe("medium");
        expect(result?.urlVerified).toBe(false);
        expect(result?.urlVerifiedDetail).toBe("HTTP 404");
      }
    );
  });

  it("real incident: a bare HF repo landing page returns HTTP 200 (genuinely reachable) but the manifest check overrides urlVerified to false because the requested file isn't actually in that repo (meituan-longcat/LongCat-Video-Avatar-1.5 does not contain LongCat-Avatar-15_bf16.safetensors, only differently-named sharded files)", async () => {
    await withTestServer(
      (req, res) => {
        if (req.url?.startsWith("/api/models/")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ siblings: [{ rfilename: "base_model/diffusion_pytorch_model-00001-of-00006.safetensors" }] }));
          return;
        }
        // The repo's own landing page: a real, reachable HTML page, HTTP 200.
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!doctype html><html>repo page</html>");
      },
      async (baseUrl) => {
        const stubRunner: FreeformSessionRunner = {
          async runFreeformSession(input) {
            return {
              sessionId: input.sessionId,
              summary: `{"matchedCandidateIndex": null, "confidence": "medium", "reason": "name prefix match", "suggestedUrl": "${baseUrl}/meituan-longcat/LongCat-Video-Avatar-1.5"}`
            };
          }
        };
        const result = await judgeFuzzyMatch({
          requestedName: "LongCat-Avatar-15_bf16.safetensors",
          candidates: [],
          runner: stubRunner,
          cwd: "/tmp",
          sessionId: "s",
          hfApiOriginOverride: baseUrl
        });
        expect(result?.urlVerified).toBe(false);
        expect(result?.urlVerifiedDetail).toContain("NOT found");
      }
    );
  });

  it("confirms urlVerified:true via the manifest when the file genuinely is listed in the repo", async () => {
    await withTestServer(
      (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ siblings: [{ rfilename: "LongCat/LongCat-Avatar-15_bf16.safetensors" }] }));
      },
      async (baseUrl) => {
        const stubRunner: FreeformSessionRunner = {
          async runFreeformSession(input) {
            return {
              sessionId: input.sessionId,
              summary: `{"matchedCandidateIndex": null, "confidence": "high", "reason": "exact filename match", "suggestedUrl": "${baseUrl}/Kijai/WanVideo_comfy/resolve/main/LongCat/LongCat-Avatar-15_bf16.safetensors"}`
            };
          }
        };
        const result = await judgeFuzzyMatch({
          requestedName: "LongCat-Avatar-15_bf16.safetensors",
          candidates: [],
          runner: stubRunner,
          cwd: "/tmp",
          sessionId: "s",
          hfApiOriginOverride: baseUrl
        });
        expect(result?.urlVerified).toBe(true);
        expect(result?.urlVerifiedDetail).toContain("confirmed in");
      }
    );
  });
});

describe("verifyFilenameInHfManifest", () => {
  it("returns fileConfirmed:true when the exact filename appears in the repo's siblings list", async () => {
    await withTestServer(
      (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ siblings: [{ rfilename: "model.safetensors" }, { rfilename: "README.md" }] }));
      },
      async (baseUrl) => {
        const result = await verifyFilenameInHfManifest(
          "https://huggingface.co/owner/repo",
          "model.safetensors",
          process.env,
          baseUrl
        );
        expect(result.fileConfirmed).toBe(true);
        expect(result.detail).toContain("confirmed in owner/repo");
      }
    );
  });

  it("returns fileConfirmed:false when the requested filename is absent from the manifest", async () => {
    await withTestServer(
      (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ siblings: [{ rfilename: "base_model/diffusion_pytorch_model-00001-of-00006.safetensors" }] }));
      },
      async (baseUrl) => {
        const result = await verifyFilenameInHfManifest(
          "https://huggingface.co/owner/repo",
          "LongCat-Avatar-15_bf16.safetensors",
          process.env,
          baseUrl
        );
        expect(result.fileConfirmed).toBe(false);
        expect(result.detail).toContain("NOT found");
      }
    );
  });

  it("matches by basename when the sibling entry has a subdirectory prefix the requested name doesn't include", async () => {
    await withTestServer(
      (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ siblings: [{ rfilename: "LongCat/LongCat-Avatar-15_bf16.safetensors" }] }));
      },
      async (baseUrl) => {
        const result = await verifyFilenameInHfManifest(
          "https://huggingface.co/owner/repo",
          "LongCat-Avatar-15_bf16.safetensors",
          process.env,
          baseUrl
        );
        expect(result.fileConfirmed).toBe(true);
      }
    );
  });

  it("returns fileConfirmed:undefined (not false) for a non-HuggingFace URL -- never treat 'could not check' as 'confirmed absent'", async () => {
    const result = await verifyFilenameInHfManifest("https://civitai.com/models/12345", "model.safetensors");
    expect(result.fileConfirmed).toBeUndefined();
  });

  it("returns fileConfirmed:undefined when the manifest lookup itself fails (network error)", async () => {
    const result = await verifyFilenameInHfManifest(
      "https://huggingface.co/owner/repo",
      "model.safetensors",
      process.env,
      "http://127.0.0.1:1" // nothing listens here
    );
    expect(result.fileConfirmed).toBeUndefined();
  });
});

describe("verifyUrlReachable", () => {
  it("reports reachable:true for a 200 response", async () => {
    await withTestServer(
      (req, res) => {
        res.writeHead(200);
        res.end();
      },
      async (baseUrl) => {
        const result = await verifyUrlReachable(`${baseUrl}/ok`);
        expect(result.reachable).toBe(true);
        expect(result.detail).toBe("HTTP 200");
      }
    );
  });

  it("reports reachable:false for a 404 response", async () => {
    await withTestServer(
      (req, res) => {
        res.writeHead(404);
        res.end();
      },
      async (baseUrl) => {
        const result = await verifyUrlReachable(`${baseUrl}/missing`);
        expect(result.reachable).toBe(false);
        expect(result.detail).toBe("HTTP 404");
      }
    );
  });

  it("follows a redirect and reports the final status", async () => {
    await withTestServer(
      (req, res) => {
        if (req.url === "/redirect") {
          res.writeHead(302, { Location: "/final" });
          res.end();
          return;
        }
        res.writeHead(200);
        res.end();
      },
      async (baseUrl) => {
        const result = await verifyUrlReachable(`${baseUrl}/redirect`);
        expect(result.reachable).toBe(true);
        expect(result.detail).toBe("HTTP 200");
      }
    );
  });

  it("reports reachable:false when the connection is refused", async () => {
    // Nothing listens on this port (server created and immediately closed).
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unexpected test server address");
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const result = await verifyUrlReachable(`http://127.0.0.1:${port}/unreachable`);
    expect(result.reachable).toBe(false);
  });

  it("rejects a non-http(s) value without spawning curl", async () => {
    const result = await verifyUrlReachable("not-a-url");
    expect(result.reachable).toBe(false);
    expect(result.detail).toContain("not an http(s) URL");
  });
});
