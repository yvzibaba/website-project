import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, __redact } from "@/lib/logger";

type WriteSpy = ReturnType<typeof vi.spyOn>;

describe("logger", () => {
  let outSpy: WriteSpy;
  let errSpy: WriteSpy;

  beforeEach(() => {
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  function lastRecord(spy: WriteSpy = outSpy): Record<string, unknown> {
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls[spy.mock.calls.length - 1]?.[0];
    expect(typeof call).toBe("string");
    return JSON.parse((call as string).trim());
  }

  it("emits single-line JSON with level, time, msg, bindings", () => {
    const log = createLogger({ app: "test" }, "info");
    log.info("hello");
    const rec = lastRecord();
    expect(rec).toMatchObject({ level: "info", msg: "hello", app: "test" });
    expect(typeof rec.time).toBe("string");
    expect(new Date(rec.time as string).toISOString()).toBe(rec.time);
  });

  it("respects level threshold (below → dropped)", () => {
    const log = createLogger({}, "warn");
    log.trace("drop");
    log.debug("drop");
    log.info("drop");
    expect(outSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    log.warn("keep");
    expect(outSpy).toHaveBeenCalledOnce();
  });

  it("silent level drops everything including fatal", () => {
    const log = createLogger({}, "silent");
    log.fatal("should not appear");
    log.error("should not appear");
    expect(outSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("routes error/fatal to stderr, others to stdout", () => {
    const log = createLogger({}, "trace");
    log.info("i");
    log.warn("w");
    expect(outSpy).toHaveBeenCalledTimes(2);
    expect(errSpy).not.toHaveBeenCalled();
    log.error("e");
    log.fatal("f");
    expect(errSpy).toHaveBeenCalledTimes(2);
    expect(outSpy).toHaveBeenCalledTimes(2); // unchanged
  });

  it("redacts top-level sensitive keys", () => {
    const log = createLogger({}, "info");
    log.info("auth", {
      password: "hunter2",
      token: "abc",
      safe: "visible",
    });
    const rec = lastRecord();
    expect(rec.password).toBe("[REDACTED]");
    expect(rec.token).toBe("[REDACTED]");
    expect(rec.safe).toBe("visible");
  });

  it("redacts deeply nested sensitive keys (objects + arrays)", () => {
    const log = createLogger({}, "info");
    log.info("deep", {
      user: { password: "p", profile: { apiKey: "k", name: "n" } },
      list: [{ secret: "s" }, { ok: 1 }],
    });
    const rec = lastRecord();
    const user = rec.user as Record<string, unknown>;
    expect(user.password).toBe("[REDACTED]");
    expect((user.profile as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect((user.profile as Record<string, unknown>).name).toBe("n");
    const list = rec.list as Array<Record<string, unknown>>;
    expect(list[0].secret).toBe("[REDACTED]");
    expect(list[1].ok).toBe(1);
  });

  it("redacts DATABASE_URL and connection_string variants", () => {
    const log = createLogger({}, "info");
    log.info("db", {
      DATABASE_URL: "postgresql://u:p@h/db",
      connectionString: "postgres://...",
    });
    const rec = lastRecord();
    expect(rec.DATABASE_URL).toBe("[REDACTED]");
    expect(rec.connectionString).toBe("[REDACTED]");
  });

  it("serializes Error objects with name/message/stack/cause", () => {
    const log = createLogger({}, "info");
    const inner = new Error("inner");
    const outer = new Error("outer", { cause: inner });
    log.error("failed", { err: outer });
    const rec = lastRecord(errSpy);
    const err = rec.err as Record<string, unknown>;
    expect(err.name).toBe("Error");
    expect(err.message).toBe("outer");
    expect(typeof err.stack).toBe("string");
    expect((err.cause as Record<string, unknown>).message).toBe("inner");
  });

  it("handles circular references without throwing", () => {
    const log = createLogger({}, "info");
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => log.info("circular", { a })).not.toThrow();
    const rec = lastRecord();
    expect((rec.a as Record<string, unknown>).self).toBe("[Circular]");
  });

  it("child() merges bindings without mutating parent", () => {
    const parent = createLogger({ app: "x" }, "info");
    const child = parent.child({ module: "y" });
    parent.info("p");
    child.info("c");
    const parentRec = JSON.parse((outSpy.mock.calls[0][0] as string).trim());
    const childRec = JSON.parse((outSpy.mock.calls[1][0] as string).trim());
    expect(parentRec).toMatchObject({ app: "x", msg: "p" });
    expect(parentRec.module).toBeUndefined();
    expect(childRec).toMatchObject({ app: "x", module: "y", msg: "c" });
  });

  it("withLevel returns a new logger with different threshold", () => {
    const a = createLogger({}, "info");
    const b = a.withLevel("error");
    a.info("shown");
    b.info("dropped");
    b.error("shown");
    expect(outSpy).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledOnce();
  });
});

describe("__redact (exported for testing)", () => {
  it("passes primitives through", () => {
    expect(__redact("s")).toBe("s");
    expect(__redact(1)).toBe(1);
    expect(__redact(true)).toBe(true);
    expect(__redact(null)).toBe(null);
    expect(__redact(undefined)).toBe(undefined);
  });

  it("converts Date to ISO string", () => {
    const d = new Date("2026-09-04T12:00:00.000Z");
    expect(__redact(d)).toBe("2026-09-04T12:00:00.000Z");
  });

  it("converts bigint to string (JSON.stringify would throw)", () => {
    expect(__redact(BigInt(42))).toBe("42");
  });

  it("converts function to descriptor", () => {
    function myFn() {}
    expect(__redact(myFn)).toBe("[Function: myFn]");
  });
});
