import { expect, it } from "vitest";
import { parseOAuthPolicies, parseOAuthCallback, parseOAuthTokenResponse, parseStoredOAuthTokens, parseOAuthSelection } from "../../apps/worker/src/contracts/oauth-values.js";
import { parseRemoteEgress } from "../../apps/worker/src/contracts/remote-values.js";
import { oauthPolicy } from "./oauth-fixtures.js";

it("W06 accepts only explicit public endpoint pins and a separate resource", () => {
  expect(parseOAuthPolicies(JSON.stringify([oauthPolicy]))).toEqual([oauthPolicy]);
  for (const key of ["resource", "issuer", "metadata_endpoint", "authorization_endpoint", "token_endpoint"]) {
    expect(parseOAuthPolicies(JSON.stringify([{ ...oauthPolicy, [key]: "http://127.0.0.1/" }]))).toBeUndefined();
  }
  expect(parseOAuthPolicies(JSON.stringify([{ ...oauthPolicy, authorization_endpoint: "https://evil.example.com/authorize" }]))).toBeUndefined();
  expect(parseOAuthPolicies(JSON.stringify([{ ...oauthPolicy, scopes: ["read", "read"] }]))).toBeUndefined();
  expect(parseOAuthPolicies(JSON.stringify([{ ...oauthPolicy, client_secret: "not-supported" }]))).toBeUndefined();
  expect(parseOAuthPolicies(JSON.stringify([oauthPolicy, oauthPolicy]))).toBeUndefined();
  expect(parseOAuthPolicies("null")).toBeUndefined();
});
it("W06 rejects ambiguous callbacks and cross-version identity inputs", () => {
  expect(parseOAuthCallback({ state: "A".repeat(43), iss: oauthPolicy.issuer, code: "code" })).toBeDefined();
  expect(parseOAuthCallback({ state: "A".repeat(43), iss: oauthPolicy.issuer, code: "code", error: "denied" })).toBeUndefined();
  expect(parseOAuthCallback({ state: "short", iss: oauthPolicy.issuer, code: "code" })).toBeUndefined();
  expect(parseOAuthSelection({ profile_id: "docs", principal: { client_id: "one", secret_version: 0 }, expected_revision: 0 })).toBeUndefined();
});
it("W06 token projection bounds lifetime, forbids scope expansion and requires rotation", () => {
  const raw = { token_type: "Bearer", access_token: "access", refresh_token: "next", expires_in: 60, scope: "read" };
  const value = parseOAuthTokenResponse(raw, ["read"], 100);
  expect(value).toEqual({ access_token: "access", refresh_token: "next", expires_at_ms: 60100, scopes: ["read"] });
  expect(parseOAuthTokenResponse(raw, ["read"], 100, "next")).toBeUndefined();
  expect(parseOAuthTokenResponse({ ...raw, scope: "read write" }, ["read"], 100)).toBeUndefined();
  expect(parseOAuthTokenResponse({ ...raw, expires_in: 0 }, ["read"], 100)).toBeUndefined();
  expect(parseOAuthTokenResponse({ ...raw, access_token: "bad\r\nheader" }, ["read"], 100)).toBeUndefined();
  expect(parseStoredOAuthTokens({ ...value, injected: "no" })).toBeUndefined();
  const { refresh_token, ...without } = raw;
  expect(parseOAuthTokenResponse(without, ["read"], 100, "previous")).not.toHaveProperty("refresh_token");
});
it("W06 only explicit legacy ephemeral sessions are accepted", () => {
  const policy = (protocol: string, session: unknown) => JSON.stringify({ schema_version: 1, endpoints: [{ endpoint: oauthPolicy.resource, protocol, session }] });
  expect(parseRemoteEgress(policy("2025-11-25", "ephemeral"))?.[0]?.session).toBe("ephemeral");
  expect(parseRemoteEgress(policy("2026-07-28", "ephemeral"))).toBeUndefined();
  expect(parseRemoteEgress(policy("2025-11-25", "persistent"))).toBeUndefined();
});
