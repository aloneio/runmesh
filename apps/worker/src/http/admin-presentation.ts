import { developmentReleaseDependencies } from "./release-cache.js";
import type { DevelopmentReleaseRefreshScheduler } from "../distribution/release.js";
import type { AdminData } from "../admin/view-models.js";
import { adminDocument } from "../admin/layout.js";
import { adminError } from "./responses.js";
import { canonicalPublicOrigin } from "../installer.js";
import { clientsPage } from "../admin/client-views.js";
import { configuredPublicOrigin } from "./origin.js";
import type { ConsoleExecutionMode } from "../contracts/runner-admin.js";
import type { EnrollmentCodeResult } from "../contracts/runner-admin.js";
import { enrollmentDocument } from "../admin/enrollment-view.js";
import { html } from "./html-response.js";
import { installerOriginUnavailable } from "./distribution.js";
import { MAX_VALIDITY_DAYS } from "../domain/execution-mode.js";
import { overviewPage, productOverviewPage } from "../admin/dashboard-views.js";
import { resolveConnectionOrigin } from "./origin.js";
import { runnerConfiguredExecutionMode } from "../domain/execution-mode.js";
import { resolveRunnerReleaseDescriptor } from "../distribution/release.js";
import type { DevelopmentReleaseCache } from "../distribution/release.js";
import type { RunnerReleaseEnvironment } from "../distribution/release.js";
import { runnersPage } from "../admin/runner-list-view.js";
import { settingsPage } from "../admin/dashboard-views.js";

export function adminPage(pathname: string, data: AdminData, csrf: string, centralEnabled = true, showActivity = false): string {
  const active = pathname === "/admin" ? "dashboard" : pathname.slice("/admin/".length) as "runners" | "clients" | "settings";
  const body = active === "runners" ? runnersPage({ configuredModes: new Map(data.runners.map(runner => [runner.runner_id, runnerConfiguredExecutionMode(runner)])), maxValidityDays: MAX_VALIDITY_DAYS }, data, csrf) : active === "clients" ? clientsPage(data, csrf, centralEnabled) : active === "settings" ? settingsPage(csrf) : centralEnabled && !showActivity ? productOverviewPage(data) : overviewPage(data, csrf);
  return adminDocument(active[0]?.toUpperCase() + active.slice(1), body, active, data.notices);
}

export async function runnerEnrollmentPage(env: RunnerReleaseEnvironment, baseUrl: string, runnerId: string, code: string | undefined, csrf: string, reEnroll = false, executionMode: ConsoleExecutionMode = "dedicated_user", confirmPrivilegedHost = false, enrollment?: Pick<Extract<EnrollmentCodeResult, { readonly ok: true }>, "created_at_ms" | "not_before_ms" | "expires_at_ms">, releaseCache?: DevelopmentReleaseCache | null, scheduleRefresh?: DevelopmentReleaseRefreshScheduler): Promise<Response> {
  if (code === undefined) return adminError(503, "Enrollment code could not be generated.");
  if (executionMode !== "dedicated_user" && executionMode !== "privileged_host") return adminError(400, "Runner execution mode is invalid.");
  if (executionMode === "privileged_host" && !confirmPrivilegedHost) return adminError(400, "Privileged-host enrollment requires the one-time risk acknowledgement.");
  const release = await resolveRunnerReleaseDescriptor(env, developmentReleaseDependencies(releaseCache), scheduleRefresh);
  const bootstrap = release.distributable;
  // Validate the origin for both the hosted and manual paths.  The manual
  // fallback still emits a server URL into a copyable command; deriving it
  // with `new URL(...).origin` alone would allow a forged Host header to send
  // the operator's one-time code to an attacker-controlled endpoint.
  let publicBase: string;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" || parsed.username !== "" || parsed.password !== "") throw new Error("enrollment base URL must be an origin");
    const headers = new Headers({ host: parsed.host });
    publicBase = resolveConnectionOrigin(new Request(parsed.toString(), { headers }), configuredPublicOrigin(env));
    if (bootstrap) publicBase = canonicalPublicOrigin(publicBase);
  } catch {
    return installerOriginUnavailable();
  }
  // Keep the original bare URL for privileged installs; the explicit query
  // selects a reviewed restricted template, never an implicit privilege upgrade.
  return html(enrollmentDocument({ publicBase, runnerId, code, csrf, reEnroll, bootstrap, executionMode, maxValidityDays: MAX_VALIDITY_DAYS, enrollment }));
}
