import { describe, expect, it } from "vitest";
import { parseEnvText } from "../src/env.ts";

describe("parseEnvText", () => {
  it("reads keys and ignores comments", () => {
    const parsed = parseEnvText(
      ["# hi", "OPENCODE_API_KEY=oc_sk_test", "EMPTY=", "GATED= glm-5.3-flash "].join(
        "\n",
      ),
    );
    expect(parsed.OPENCODE_API_KEY).toBe("oc_sk_test");
    expect(parsed.EMPTY).toBe("");
    expect(parsed.GATED).toBe("glm-5.3-flash");
  });
});
