/** Dependency-free metadata checks. The same function bodies are embedded in
 * CI jobs so the source-branch gate never executes a PR checkout or npm code.
 * These checks supplement server-side PR/protected-branch enforcement. */
export function githubMainPromotion(event, environment) {
  const reject = () => { throw new Error("main accepts only an open pull request from this repository's dev branch"); };
  const pr = event?.pull_request;
  const id = environment.GITHUB_REPOSITORY_ID;
  if (environment.GITHUB_EVENT_NAME !== "pull_request"
    || !/^[1-9][0-9]*$/u.test(id ?? "")
    || !["opened", "reopened", "synchronize", "edited", "ready_for_review"].includes(event?.action)
    || pr?.state !== "open" || !Number.isSafeInteger(pr.number) || pr.number < 1
    || environment.GITHUB_REF !== `refs/pull/${pr.number}/merge`
    || String(event.repository?.id) !== id
    || String(pr.base?.repo?.id) !== id || String(pr.head?.repo?.id) !== id
    || pr.base?.repo?.full_name !== environment.GITHUB_REPOSITORY
    || pr.head?.repo?.full_name !== environment.GITHUB_REPOSITORY
    || pr.base?.ref !== "main" || pr.head?.ref !== "dev"
    || typeof pr.head?.sha !== "string" || !/^[a-f0-9]{40}$/u.test(pr.head.sha)) reject();
  return { policy: "main-from-dev-v1", allowed: true, pull_request: pr.number };
}

export function gitlabMainPromotion(environment) {
  const reject = () => { throw new Error("main accepts only a same-project dev merge request with current MR metadata"); };
  if (environment.CI_PIPELINE_SOURCE !== "merge_request_event"
    || !/^[1-9][0-9]*$/u.test(environment.CI_MERGE_REQUEST_IID ?? "")
    || typeof environment.CI_MERGE_REQUEST_TARGET_BRANCH_NAME !== "string"
    || environment.CI_MERGE_REQUEST_TARGET_BRANCH_NAME.length === 0) reject();
  if (environment.CI_MERGE_REQUEST_TARGET_BRANCH_NAME !== "main") {
    return { policy: "main-from-dev-v1", applies: false };
  }
  // The MR project is its target project. GitLab does not define a
  // CI_MERGE_REQUEST_TARGET_PROJECT_ID environment variable.
  const id = environment.CI_PROJECT_ID;
  if (!/^[1-9][0-9]*$/u.test(id ?? "")
    || environment.CI_MERGE_REQUEST_SOURCE_PROJECT_ID !== id
    || environment.CI_MERGE_REQUEST_PROJECT_ID !== id
    || environment.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME !== "dev") reject();
  return { policy: "main-from-dev-v1", allowed: true };
}
