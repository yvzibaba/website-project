import { describe, it, expect } from "vitest";
import { cn } from "@/lib/cn";

describe("cn — className 合并", () => {
  it("joins string arguments with a space", () => {
    expect(cn("px-2", "py-1")).toBe("px-2 py-1");
  });

  it("drops falsy values (null/undefined/false/empty string)", () => {
    expect(cn("a", null, undefined, false, "", "b")).toBe("a b");
  });

  it("keeps numeric 0 but drops other falsy numbers handling", () => {
    expect(cn("a", 0, "b")).toBe("a 0 b");
  });

  it("includes truthy conditional expressions", () => {
    const isActive = true;
    const isDisabled = false;
    expect(cn("base", isActive && "active", isDisabled && "disabled")).toBe(
      "base active",
    );
  });

  it("flattens nested arrays", () => {
    expect(cn(["a", ["b", "c"]], "d")).toBe("a b c d");
  });

  it("includes object keys whose values are truthy", () => {
    expect(cn({ active: true, disabled: false, hidden: 0, visible: 1 })).toBe(
      "active visible",
    );
  });

  it("trims whitespace-only strings", () => {
    expect(cn("  a  ", "   ", "b")).toBe("a b");
  });

  it("returns empty string when nothing truthy is passed", () => {
    expect(cn(null, undefined, false, "")).toBe("");
    expect(cn()).toBe("");
  });

  it("handles mixed input types together", () => {
    expect(
      cn("a", ["b", { c: true, d: false }], null, "e", 1),
    ).toBe("a b c e 1");
  });
});
