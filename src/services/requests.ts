import { randomUUID } from "node:crypto";
import {
  countRequests,
  createRequestRecord,
  findPendingRequest,
  getRequest,
  listRequests,
  resolveRequest,
} from "../db.js";
import { getPlan } from "../plans.js";
import type { RequestRecord, Subscription } from "../types.js";
import { activatePlan } from "./subscriptions.js";

/** Сколько заявок показывать в админке за раз. */
export const REQUESTS_PAGE_SIZE = 5;

export type SubmitResult =
  | { ok: true; request: RequestRecord }
  | { ok: false; reason: "unknown_plan" | "already_pending"; request?: RequestRecord };

/**
 * Заявка на подписку. Одна незакрытая заявка на пользователя: повторная подача
 * возвращает уже существующую, чтобы админ не разбирал дубли.
 */
export function submitRequest(input: {
  telegramId: number;
  username?: string | null;
  planCode: string;
  comment?: string | null;
}): SubmitResult {
  const plan = getPlan(input.planCode);
  if (!plan) return { ok: false, reason: "unknown_plan" };

  const pending = findPendingRequest(input.telegramId);
  if (pending) return { ok: false, reason: "already_pending", request: pending };

  const request = createRequestRecord({
    id: randomUUID(),
    telegramId: input.telegramId,
    username: input.username ?? null,
    planCode: plan.code,
    comment: input.comment ?? null,
  });
  return { ok: true, request };
}

export const pendingRequests = (limit = REQUESTS_PAGE_SIZE): RequestRecord[] =>
  listRequests("pending", limit);

export const pendingRequestsCount = (): number => countRequests("pending");

export const getRequestById = (id: string): RequestRecord | undefined =>
  getRequest(id);

export type ApproveResult =
  | { ok: true; request: RequestRecord; subscription: Subscription }
  | {
      ok: false;
      reason: "not_found" | "already_resolved" | "plan_missing" | "provision_failed";
    };

/** Одобрение заявки: выдаёт подписку по тарифу из заявки (и заводит ключ). */
export async function approveRequest(input: {
  id: string;
  actor: number | null;
}): Promise<ApproveResult> {
  const request = getRequest(input.id);
  if (!request) return { ok: false, reason: "not_found" };
  if (request.status !== "pending") return { ok: false, reason: "already_resolved" };
  if (!getPlan(request.planCode)) return { ok: false, reason: "plan_missing" };

  try {
    const subscription = await activatePlan(request.telegramId, request.planCode);
    resolveRequest(request.id, "approved", input.actor);
    return {
      ok: true,
      request: getRequest(request.id) as RequestRecord,
      subscription,
    };
  } catch {
    return { ok: false, reason: "provision_failed" };
  }
}

export type RejectResult =
  | { ok: true; request: RequestRecord }
  | { ok: false; reason: "not_found" | "already_resolved" };

export function rejectRequest(input: {
  id: string;
  actor: number | null;
}): RejectResult {
  const request = getRequest(input.id);
  if (!request) return { ok: false, reason: "not_found" };
  if (request.status !== "pending") return { ok: false, reason: "already_resolved" };
  resolveRequest(request.id, "rejected", input.actor);
  return { ok: true, request: getRequest(request.id) as RequestRecord };
}
