import axios, { AxiosInstance } from "axios";

export interface Rule {
  key: string;
  type: string;
  version: number;
  jsonSchema: Record<string, unknown>;
}

export interface RuleIdentifier {
  key: string;
  type: string;
  version: number;
}

export interface SegmentClient {
  fetchAllRules(trackingPlanId: string): Promise<Rule[]>;
  patchRules(trackingPlanId: string, rules: Rule[]): Promise<void>;
  deleteRules(
    trackingPlanId: string,
    rules: RuleIdentifier[],
  ): Promise<void>;
}

export interface SegmentClientOptions {
  apiKey: string;
  baseUrl?: string;
  paginationCount?: number;
  batchSize?: number;
}

export class SegmentApiError extends Error {
  readonly code = "SEGMENT_API" as const;
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, SegmentApiError.prototype);
  }

  static fromAxios(err: unknown, context: string): SegmentApiError {
    if (axios.isAxiosError(err)) {
      return new SegmentApiError(
        `${context}: ${err.message}`,
        err.response?.status,
        err.response?.data,
      );
    }
    return new SegmentApiError(
      `${context}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function createSegmentClient(
  opts: SegmentClientOptions,
): SegmentClient {
  const baseUrl = opts.baseUrl ?? "https://api.segmentapis.com";
  const paginationCount = opts.paginationCount ?? 100;
  const batchSize = opts.batchSize ?? 200;
  const http: AxiosInstance = axios.create({
    baseURL: baseUrl,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
  });

  async function fetchAllRules(trackingPlanId: string): Promise<Rule[]> {
    const url = `/tracking-plans/${trackingPlanId}/rules`;
    const accumulated: Rule[] = [];
    let cursor: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = new URLSearchParams({
        "pagination[count]": String(paginationCount),
      });
      if (cursor) params.append("pagination[cursor]", cursor);
      try {
        const res = await http.get(`${url}?${params.toString()}`);
        const rules = (res.data?.data?.rules ?? []) as Rule[];
        accumulated.push(...rules);
        const next = res.data?.data?.pagination?.next as string | undefined;
        if (!next) return accumulated;
        cursor = next;
      } catch (err) {
        throw SegmentApiError.fromAxios(err, `fetchAllRules(${trackingPlanId})`);
      }
    }
  }

  async function patchRules(
    trackingPlanId: string,
    rules: Rule[],
  ): Promise<void> {
    const url = `/tracking-plans/${trackingPlanId}/rules`;
    for (let i = 0; i < rules.length; i += batchSize) {
      const chunk = rules.slice(i, i + batchSize);
      try {
        await http.patch(url, { rules: chunk });
      } catch (err) {
        throw SegmentApiError.fromAxios(
          err,
          `patchRules(${trackingPlanId}) batch ${i / batchSize + 1}`,
        );
      }
    }
  }

  async function deleteRules(
    trackingPlanId: string,
    rules: RuleIdentifier[],
  ): Promise<void> {
    const url = `/tracking-plans/${trackingPlanId}/rules`;
    for (let i = 0; i < rules.length; i += batchSize) {
      const chunk = rules.slice(i, i + batchSize);
      try {
        await http.delete(url, { data: { rules: chunk } });
      } catch (err) {
        throw SegmentApiError.fromAxios(
          err,
          `deleteRules(${trackingPlanId}) batch ${i / batchSize + 1}`,
        );
      }
    }
  }

  return { fetchAllRules, patchRules, deleteRules };
}
