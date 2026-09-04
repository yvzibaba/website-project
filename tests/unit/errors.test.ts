import { describe, it, expect, afterEach, vi } from "vitest";
import {
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitedError,
  DBError,
  UpstreamError,
  isAppError,
  toErrorResponse,
} from "@/lib/errors";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AppError code → HTTP status mapping", () => {
  it("maps each subclass to its canonical status", () => {
    expect(new ValidationError("x").httpStatus).toBe(400);
    expect(new UnauthorizedError("x").httpStatus).toBe(401);
    expect(new ForbiddenError("x").httpStatus).toBe(403);
    expect(new NotFoundError("x").httpStatus).toBe(404);
    expect(new ConflictError("x").httpStatus).toBe(409);
    expect(new RateLimitedError("x").httpStatus).toBe(429);
    expect(new DBError("x").httpStatus).toBe(500);
    expect(new UpstreamError("x").httpStatus).toBe(502);
  });

  it("allows httpStatus override", () => {
    const e = new AppError("CONFLICT", "dup", { httpStatus: 422 });
    expect(e.httpStatus).toBe(422);
    expect(e.code).toBe("CONFLICT");
  });

  it("falls back to 500 for unknown code (defensive)", () => {
    // Force-cast to bypass TS enum — testing runtime fallback
    const e = new AppError("SOMETHING_NEW" as never, "x");
    expect(e.httpStatus).toBe(500);
  });
});

describe("AppError serialization", () => {
  it("toJSON returns stable envelope with code + message", () => {
    const e = new ValidationError("email invalid");
    expect(e.toJSON()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "email invalid" },
    });
  });

  it("includes details when provided", () => {
    const e = new ValidationError("bad input", {
      details: { field: "email", reason: "format" },
    });
    expect(e.toJSON()).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "bad input",
        details: { field: "email", reason: "format" },
      },
    });
  });

  it("omits details key entirely when not set (not undefined)", () => {
    const e = new NotFoundError("missing");
    const json = e.toJSON();
    expect("details" in json.error).toBe(false);
  });

  it("preserves Error.cause chain", () => {
    const inner = new Error("inner boom");
    const outer = new DBError("wrap", { cause: inner });
    expect(outer.cause).toBe(inner);
  });

  it("sets name and isAppError flag", () => {
    const e = new ValidationError("x");
    expect(e.name).toBe("ValidationError");
    expect(e.isAppError).toBe(true);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toBeInstanceOf(Error);
  });
});

describe("isAppError guard", () => {
  it("true for AppError instances", () => {
    expect(isAppError(new ValidationError("x"))).toBe(true);
    expect(isAppError(new AppError("DB_ERROR", "x"))).toBe(true);
  });

  it("false for plain errors and nullish", () => {
    expect(isAppError(new Error("plain"))).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
    expect(isAppError("string")).toBe(false);
    expect(isAppError(42)).toBe(false);
  });

  it("true for cross-realm duck-typed object (isAppError:true + code)", () => {
    const foreign = { isAppError: true, code: "NOT_FOUND", message: "gone", httpStatus: 404 };
    expect(isAppError(foreign)).toBe(true);
  });

  it("false if isAppError:true but code missing", () => {
    expect(isAppError({ isAppError: true })).toBe(false);
  });
});

describe("toErrorResponse", () => {
  it("passes through AppError status + body", () => {
    const r = toErrorResponse(new NotFoundError("case 42 missing"));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({
      error: { code: "NOT_FOUND", message: "case 42 missing" },
    });
  });

  it("maps Prisma P2002 (unique constraint) to 409 CONFLICT", () => {
    const r = toErrorResponse({ code: "P2002", message: "unique" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("CONFLICT");
  });

  it("maps Prisma P2025 (record not found) to 404 NOT_FOUND", () => {
    const r = toErrorResponse({ code: "P2025", message: "gone" });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("NOT_FOUND");
  });

  it("maps other Prisma P#### codes to 500 DB_ERROR", () => {
    const r = toErrorResponse({ code: "P1001", message: "cant connect" });
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("DB_ERROR");
  });

  it("falls back to INTERNAL_ERROR for unknown errors (non-prod reveals message)", () => {
    vi.stubEnv("NODE_ENV", "development");
    const r = toErrorResponse(new Error("raw oops"));
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("INTERNAL_ERROR");
    expect(r.body.error.message).toBe("raw oops");
  });

  it("hides raw message in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const r = toErrorResponse(new Error("secret internal detail"));
    expect(r.body.error.message).toBe("服务器内部错误");
    expect(r.body.error.message).not.toContain("secret");
  });

  it("handles non-Error thrown values", () => {
    const r = toErrorResponse("string thrown");
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("INTERNAL_ERROR");
  });
});
