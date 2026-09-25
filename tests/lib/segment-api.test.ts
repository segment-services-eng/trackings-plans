import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { createSegmentClient, SegmentApiError } from "../../lib/segment-api.js";

const BASE = "https://api.segmentapis.com";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("segment-api", () => {
  it("fetchAllRules paginates across multiple pages", async () => {
    const page1 = {
      data: {
        rules: [{ key: "A", type: "TRACK", version: 1, jsonSchema: {} }],
        pagination: { current: "0", next: "cursor2" },
      },
    };
    const page2 = {
      data: {
        rules: [{ key: "B", type: "TRACK", version: 1, jsonSchema: {} }],
        pagination: { current: "cursor2" },
      },
    };
    server.use(
      http.get(`${BASE}/tracking-plans/tp_1/rules`, ({ request }) => {
        const url = new URL(request.url);
        return HttpResponse.json(
          url.searchParams.get("pagination[cursor]") === "cursor2" ? page2 : page1,
        );
      }),
    );

    const client = createSegmentClient({ apiKey: "x" });
    const rules = await client.fetchAllRules("tp_1");
    expect(rules.map((r) => r.key)).toEqual(["A", "B"]);
  });

  it("fetchAllRules throws SegmentApiError on non-2xx", async () => {
    server.use(
      http.get(`${BASE}/tracking-plans/tp_1/rules`, () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );
    const client = createSegmentClient({ apiKey: "x" });
    await expect(client.fetchAllRules("tp_1")).rejects.toBeInstanceOf(
      SegmentApiError,
    );
  });

  it("patchRules batches at 200 per request", async () => {
    const bodies: Array<{ rules: unknown[] }> = [];
    server.use(
      http.patch(`${BASE}/tracking-plans/tp_1/rules`, async ({ request }) => {
        bodies.push((await request.json()) as { rules: unknown[] });
        return HttpResponse.json({ data: {} });
      }),
    );

    const rules = Array.from({ length: 450 }, (_, i) => ({
      key: `E${i}`,
      type: "TRACK",
      version: 1,
      jsonSchema: {},
    }));
    const client = createSegmentClient({ apiKey: "x" });
    await client.patchRules("tp_1", rules);
    expect(bodies).toHaveLength(3);
    expect(bodies[0].rules).toHaveLength(200);
    expect(bodies[2].rules).toHaveLength(50);
  });

  it("deleteRules batches at 200 per request", async () => {
    const bodies: Array<{ rules: unknown[] }> = [];
    server.use(
      http.delete(`${BASE}/tracking-plans/tp_1/rules`, async ({ request }) => {
        bodies.push((await request.json()) as { rules: unknown[] });
        return HttpResponse.json({ data: {} });
      }),
    );
    const rules = Array.from({ length: 250 }, (_, i) => ({
      key: `E${i}`,
      type: "TRACK",
      version: 1,
    }));
    const client = createSegmentClient({ apiKey: "x" });
    await client.deleteRules("tp_1", rules);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].rules).toHaveLength(50);
  });
});
