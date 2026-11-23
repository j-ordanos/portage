import { describe, expect, it } from "vitest";
import { healthResponse } from "./index.js";

describe("healthResponse", () => {
  it("accepts the server health shape", () => {
    expect(healthResponse.parse({ ok: true, version: "0.1.0" })).toEqual({
      ok: true,
      version: "0.1.0",
    });
  });
});
