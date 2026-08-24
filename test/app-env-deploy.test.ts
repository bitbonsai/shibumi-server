import { describe, expect, test } from "bun:test";
import { composeOverride } from "../src/deploy";
import { parseCliArgs } from "../src/cli-args";

describe("composeOverride app env", () => {
  test("injects stored env into the service environment block", () => {
    const yaml = composeOverride("web", "localhost/img:tag", { commit: "abc", deployedAt: "2026-01-01T00:00:00Z" }, {
      APP_ORIGIN: "https://app.example.com",
      RESEND_API_KEY: "re_secret",
    });
    expect(yaml).toContain('image: "localhost/img:tag"');
    expect(yaml).toContain("environment:");
    expect(yaml).toContain('APP_ORIGIN: "https://app.example.com"');
    expect(yaml).toContain('RESEND_API_KEY: "re_secret"');
    expect(yaml).toContain('SHIBUMI_COMMIT: "abc"');
  });

  test("reserved SHIBUMI_ keys are not overridden by stored env", () => {
    const yaml = composeOverride("web", undefined, { commit: "real", deployedAt: "t" }, { SHIBUMI_COMMIT: "spoof" });
    expect(yaml).toContain('SHIBUMI_COMMIT: "real"');
    expect(yaml).not.toContain('SHIBUMI_COMMIT: "spoof"');
  });

  test("no environment block when there is nothing to inject", () => {
    const yaml = composeOverride("web", "localhost/img:tag");
    expect(yaml).not.toContain("environment:");
  });
});

describe("parseCliArgs env", () => {
  test("parses set/list/rm", () => {
    expect(parseCliArgs(["env", "set", "my-app"])).toEqual({ name: "env", action: "set", appId: "my-app", keys: [], json: false });
    expect(parseCliArgs(["env", "list", "my-app", "--json"])).toEqual({ name: "env", action: "list", appId: "my-app", keys: [], json: true });
    expect(parseCliArgs(["env", "rm", "my-app", "A", "B"])).toEqual({ name: "env", action: "rm", appId: "my-app", keys: ["A", "B"], json: false });
  });

  test("rejects bad forms", () => {
    expect(() => parseCliArgs(["env", "bogus", "my-app"])).toThrow("set, list, or rm");
    expect(() => parseCliArgs(["env", "set"])).toThrow("app id");
    expect(() => parseCliArgs(["env", "set", "my-app", "A=1"])).toThrow("stdin");
    expect(() => parseCliArgs(["env", "rm", "my-app"])).toThrow("one or more KEY");
  });
});
