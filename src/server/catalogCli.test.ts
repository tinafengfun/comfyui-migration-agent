import { describe, expect, it } from "vitest";
import { parseLeaseArgs, parseExploreArgs } from "./catalogCliArgs";

describe("parseLeaseArgs", () => {
  it("parses an acquire invocation with defaults", () => {
    expect(parseLeaseArgs(["--node-key", "o__p", "--action", "acquire", "--holder", "agentA"])).toEqual({
      action: "acquire",
      nodeKey: "o__p",
      holder: "agentA",
      ttlSec: 600
    });
  });

  it("parses heartbeat/release with lease-id + ttl", () => {
    expect(parseLeaseArgs(["--action", "heartbeat", "--node-key", "o__p", "--lease-id", "L1", "--ttl", "120"])).toMatchObject({
      action: "heartbeat",
      leaseId: "L1",
      ttlSec: 120
    });
  });
});

describe("parseExploreArgs", () => {
  it("parses record with default max 3", () => {
    expect(parseExploreArgs(["--workspace", "/ws/artifacts", "--node-key", "o__p", "--action", "record"])).toEqual({
      action: "record",
      artifactPath: "/ws/artifacts",
      nodeKey: "o__p",
      max: 3
    });
  });

  it("parses status + custom max", () => {
    expect(parseExploreArgs(["--action", "status", "--workspace", "/ws", "--node-key", "k", "--max", "5"])).toMatchObject({
      action: "status",
      max: 5
    });
  });
});
