import { describe, expect, test } from "bun:test";
import { handleRequest } from "../src/server";

describe("devcontainer sample server", () => {
  test("serves the root endpoint", async () => {
    const response = handleRequest(new Request("http://localhost/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      message: "hello from bun in a devcontainer",
    });
  });

  test("serves a health check", async () => {
    const response = handleRequest(new Request("http://localhost/healthz"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
