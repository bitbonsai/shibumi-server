import { createHmac, timingSafeEqual } from "node:crypto";

export interface GitHubPush {
  repository: string;
  ref: string;
  commit: string;
}

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
const DELIVERY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}$/;

export function isGitHubSignature(value: string | null): boolean {
  return value !== null && SIGNATURE.test(value);
}

export function normalizeGitHubDeliveryId(value: string | null): string | undefined {
  return value !== null && DELIVERY.test(value) ? value.toLowerCase() : undefined;
}

export function verifyGitHubSignature(secret: string, body: Uint8Array, signature: string | null): boolean {
  const match = signature?.match(SIGNATURE);
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const received = Buffer.from(match[1], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function parseGitHubPush(value: unknown): GitHubPush {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  const repositoryValue = payload.repository;
  if (!repositoryValue || typeof repositoryValue !== "object" || Array.isArray(repositoryValue)) {
    throw new Error("payload.repository must be an object");
  }

  const repository = (repositoryValue as Record<string, unknown>).full_name;
  if (typeof repository !== "string" || repository.length === 0) {
    throw new Error("payload.repository.full_name is required");
  }
  if (typeof payload.ref !== "string" || payload.ref.length === 0) {
    throw new Error("payload.ref is required");
  }
  if (payload.deleted === true) throw new Error("deleted branches cannot be deployed");
  if (typeof payload.after !== "string" || !COMMIT.test(payload.after)) {
    throw new Error("payload.after must be a full lowercase commit SHA");
  }

  return { repository, ref: payload.ref, commit: payload.after };
}
