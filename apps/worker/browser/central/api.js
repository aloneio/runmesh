import { centralRequestContract } from './request-contract.js';
import { validSkillLifecycleReceipt } from './skill-lifecycle-receipts.js';
import { validSkillSourceReceipt } from './skill-source-receipts.js';
import { validServiceInspection, validRegistryPreview } from './service-receipts.js';
import { classifyCentralFailure } from './failures.js';

/** Network and receipt handling. The controller owns write admission. */
export function createCentralApi({
  csrf,
  t,
  isCurrent,
  refreshRequired,
  requireRefresh,
  sourceTimeoutMs
}) {
  function assertCurrent() {
    if (!isCurrent()) throw new DOMException('View is no longer active', 'AbortError');
  }
  async function api(path, body, missing) {
    assertCurrent();
    const request = centralRequestContract(path, body, missing);
    const { lifecycle, sourceAction, inspection, registry, mutation, scope } = request;
    if (mutation && refreshRequired(scope)) throw new Error(t('refreshTheLibraryBeforeMakingAnotherChange'));
    var confirmedRejection = false,
      ctl = new AbortController(),
      timer = setTimeout(function () {
        ctl.abort();
      }, sourceAction && Number.isSafeInteger(sourceTimeoutMs) && sourceTimeoutMs > 0 ? sourceTimeoutMs : 25000);
    try {
      var response = await fetch('/admin/central/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: ctl.signal,
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      }).catch(() => {
        throw new Error(t('connectionInterruptedRefreshToCheckWhetherTheOperationCompleted'));
      });
      var value;
      try {
        value = await response.json();
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
      }
      assertCurrent();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
      if (!response.ok) {
        const failure = classifyCentralFailure(request, response.status, value);
        confirmedRejection = failure.confirmedNotStarted;
        throw Object.assign(new Error(failure.message ?? t(failure.messageKey)), failure.details);
      }
      if (!request.states.includes(value.state)) throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
      if (request.collection && (!Array.isArray(value[request.collection])
        || !(value.next_after === null || typeof value.next_after === 'string' && value.next_after.length > 0))) {
        throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
      }
      if (request.optionalCatalog && value.state === 'empty') return null;
      if (lifecycle && !validSkillLifecycleReceipt(lifecycle, body, value)) throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
      if (sourceAction && !validSkillSourceReceipt(sourceAction, body, value)) throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
      if (inspection && !validServiceInspection(value)) throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
      if (registry && !validRegistryPreview(value)) throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
      // A successful state alone cannot supply the identity/revision needed by
      // the next workflow step. An incomplete write still requires reconciliation.
      if (body && path.startsWith('profiles/') && (value.profile?.profile_id !== decodeURIComponent(path.slice('profiles/'.length))
        || !Number.isSafeInteger(value.profile?.revision) || value.profile.revision < 1
        || typeof value.profile.enabled !== 'boolean' || !['none', 'oauth'].includes(value.profile.authentication))) {
        throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
      }
      if (body && path === 'connections/begin') {
        if (typeof value.authorization_url !== 'string' || !value.authorization_url.trim()) throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
        try { new URL(value.authorization_url, 'https://runmesh.invalid'); }
        catch { throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange')); }
      }
      if (body && path === 'skill-installations' && ['skill_id', 'name', 'digest'].some(key => typeof value[key] !== 'string' || !value[key])) {
        throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
      }
      return value;
    } catch (error) {
      if (mutation && !confirmedRejection) requireRefresh(scope);
      assertCurrent();
      if (error.name === 'AbortError') throw new Error(t('connectionInterruptedRefreshToCheckWhetherTheOperationCompleted'));
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function pages(path) {
    const { collection } = centralRequestContract(path);
    if (!collection || collection !== path) throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
    var all = [],
      after = null,
      seen = new Set();
    do {
      var value = await api(path + (after ? '?after=' + encodeURIComponent(after) : ''));
      all = all.concat(value[collection]);
      after = value.next_after;
      if (after && (seen.has(after) || value[collection].length === 0)) throw new Error(t('couldNotLoadTheCompleteLibraryRefreshBeforeChanging'));
      seen.add(after);
      if (all.length > 1000) throw new Error(t('libraryIsTooLargeToDisplay'));
    } while (after);
    return all;
  }
  return {
    request: api,
    list: pages
  };
}
