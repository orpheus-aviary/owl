import type { FastifyReply } from 'fastify';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error_code?: string;
  details?: Record<string, unknown>;
  total?: number;
}

export function ok<T>(reply: FastifyReply, data: T, message?: string, total?: number): void {
  const body: ApiResponse<T> = { success: true, data, message };
  if (total !== undefined) body.total = total;
  reply.send(body);
}

export function created<T>(reply: FastifyReply, data: T, message?: string): void {
  reply.status(201).send({ success: true, data, message } satisfies ApiResponse<T>);
}

export function fail(
  reply: FastifyReply,
  status: number,
  message: string,
  errorCode?: string,
  details?: Record<string, unknown>,
): void {
  const body: ApiResponse = {
    success: false,
    message,
    error_code: errorCode,
  };
  if (details !== undefined) body.details = details;
  reply.status(status).send(body);
}
