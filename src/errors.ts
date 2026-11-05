/** Typed error codes surfaced to agents and callers. */
export const ErrorCode = {
  INVALID_INTENT: "INVALID_INTENT",
  UNSUPPORTED_CHAIN: "UNSUPPORTED_CHAIN",
  KILL_SWITCH_ACTIVE: "KILL_SWITCH_ACTIVE",
  SPEND_CAP_EXCEEDED: "SPEND_CAP_EXCEEDED",
  DAILY_CAP_EXCEEDED: "DAILY_CAP_EXCEEDED",
  DESTINATION_NOT_ALLOWED: "DESTINATION_NOT_ALLOWED",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  CHAIN_MISMATCH: "CHAIN_MISMATCH",
  MPC_SIGNING_FAILED: "MPC_SIGNING_FAILED",
  SIGNATURE_MISMATCH: "SIGNATURE_MISMATCH",
  BROADCAST_FAILED: "BROADCAST_FAILED",
  QUEUE_FULL: "QUEUE_FULL",
  EXECUTION_FAILED: "EXECUTION_FAILED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Error codes produced by the policy engine (always raised before any MPC call). */
export type PolicyErrorCode =
  | typeof ErrorCode.KILL_SWITCH_ACTIVE
  | typeof ErrorCode.SPEND_CAP_EXCEEDED
  | typeof ErrorCode.DAILY_CAP_EXCEEDED
  | typeof ErrorCode.DESTINATION_NOT_ALLOWED;

export class GhostSignError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GhostSignError";
    this.code = code;
    this.details = details;
  }
}

export class PolicyViolationError extends GhostSignError {
  declare readonly code: PolicyErrorCode;

  constructor(code: PolicyErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = "PolicyViolationError";
  }
}

export function isGhostSignError(err: unknown): err is GhostSignError {
  return err instanceof GhostSignError;
}
