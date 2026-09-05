/** Every failure the CLI or server reports carries a stable code and whether a retry could help. */
export class DemoreelError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus: number;
  constructor(message: string, opts: { code: string; retryable?: boolean; httpStatus?: number; cause?: unknown } ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.httpStatus = opts.httpStatus ?? 500;
  }
}

export class ValidationError extends DemoreelError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "validation", httpStatus: 400, cause });
  }
}

/** The target was refused by a guard (private host, robots.txt, login page, ...). Never retried. */
export class GuardError extends DemoreelError {
  constructor(message: string, code = "guard") {
    super(message, { code, httpStatus: 403 });
  }
}

export class CapacityError extends DemoreelError {
  constructor(message = "At capacity right now. Try again in a few minutes.") {
    super(message, { code: "capacity", retryable: true, httpStatus: 429 });
  }
}

export class PlannerError extends DemoreelError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "planner", retryable: true, httpStatus: 502, cause });
  }
}

export class DriveError extends DemoreelError {
  constructor(message: string, cause?: unknown, retryable = false) {
    super(message, { code: "drive", retryable, httpStatus: 502, cause });
  }
}

export class RenderError extends DemoreelError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "render", httpStatus: 500, cause });
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
