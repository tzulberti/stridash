/**
 * Garmin SSO pure-function helpers: widget MFA var parsing, page title.
 * (Flow logic is covered live during real-account E2E; Google-style HTML
 * fixtures below come from the widget pages documented in python-garminconnect.)
 */
import { describe, expect, it } from "vitest";
import { describe, expect, it } from "vitest";
import { parseWidgetMfaVars, pageTitle, peekJwtExpMs } from "../src/providers/garmin/sso.js";

describe("parseWidgetMfaVars", () => {
  it("extracts the inline JS variables from the widget MFA page", () => {
    const html = `<script>
      var customerGuid = "1q2w3e4r-5t6y-7u8i";
      var mfaMethod    = "email";
      var locale       = "en-US";
      var clientId     = "gauth-widget";
      var codeSentTo   = "t***@mail.com";
    </script>`;
    expect(parseWidgetMfaVars(html)).toEqual({
      customerGuid: "1q2w3e4r-5t6y-7u8i",
      mfaMethod: "email",
      locale: "en-US",
      clientId: "gauth-widget",
      codeSentTo: "t***@mail.com",
    });
  });

  it("returns an empty object when there are no MFA variables", () => {
    expect(parseWidgetMfaVars("<html><body /></html>")).toEqual({});
  });
});

describe("pageTitle", () => {
  it("reads the <title>", () => {
    expect(pageTitle("<head><title>Success</title></head>")).toBe("Success");
  });
  it("returns '' without a title", () => {
    expect(pageTitle("<head></head>")).toBe("");
  });
});

describe("peekJwtExpMs", () => {
  it("decodes the exp claim", () => {
    const payload = Buffer.from(
      JSON.stringify({ exp: 1_700_000_000, client_id: "X" }),
    ).toString("base64url");
    expect(peekJwtExpMs(`abc.${payload}.def`)).toBe(1_700_000_000_000);
  });
  it("returns null on garbage", () => {
    expect(peekJwtExpMs("not-a-jwt")).toBeNull();
  });
});
