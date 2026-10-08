import { JobsResponseContract } from "./saved-response-contract.js";
import type { Response } from "./model";

type ResponseContract = {
  normalizeKeyword(value: string): string;
  normalizeRecord(value: unknown): Response;
  parseList(value: unknown): Response[];
  readList(value: unknown): {
    data: Response[];
    rejected: { index: number; reason: string }[];
    invalidCount: number;
  };
  preserveRejected(original: unknown, value: unknown): unknown[];
};
export const savedResponses = JobsResponseContract as ResponseContract;
