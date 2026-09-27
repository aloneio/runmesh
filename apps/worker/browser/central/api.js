/** Network and receipt handling. The controller owns write admission. */
export function createCentralApi({
  csrf,
  t,
  isCurrent,
  refreshRequired,
  requireRefresh
}) {
  function assertCurrent() {
    if (!isCurrent()) throw new DOMException('View is no longer active', 'AbortError');
  }
  async function api(path, body, missing) {
    assertCurrent();
    if (body && body.action !== 'preview' && refreshRequired()) throw new Error(t('refreshTheLibraryBeforeMakingAnotherChange'));
    var ctl = new AbortController(),
      timer = setTimeout(function () {
        ctl.abort();
      }, 25000);
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
      });
      var value = await response.json();
      assertCurrent();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
      if (missing && response.status === 404 && (value.state === 'missing' || value.error && value.error.code === 'central_missing')) return null;
      if (!response.ok) {
        if (body && body.action !== 'preview') requireRefresh();
        var code = value.error && value.error.code;
        if (response.status === 409 && path === 'skill-installations' && value.state === 'conflict') {
          var conflict = new Error('skill_exists');
          conflict.skillId = value.skill_id;
          conflict.revision = value.current_revision;
          throw conflict;
        }
        if (response.status === 409) throw new Error(t('thisItemChangedRefreshAndReviewItAgainBefore'));
        if (response.status === 403) throw new Error(t('accessWasDeniedSignInAgainOrCheckThe'));
        if (response.status === 400) throw new Error(t('checkTheFieldsAndSkillFileFormatSkillMd'));
        if (code === 'oauth_provider_unsupported') throw new Error(t('thisServiceDoesNotSupportAutomaticOauthConnectionCheck'));
        if (code === 'remote_authorization_required' || code === 'oauth_reauthorization_required') throw new Error(t('signInToThisServiceAgainUsingReconnect'));
        if (code === 'oauth_unavailable') throw new Error(t('authorizationCouldNotBeCompletedRefreshAndReconnectIf'));
        if (code === 'remote_egress_denied' || code === 'remote_endpoint_denied' || code === 'central_disabled') throw new Error(t('enterAPublicHttpsMcpUrlPrivateAddressesAnd'));
        throw new Error(t('operationCouldNotBeConfirmedRefreshTheCurrentState'));
      }
      var expected = body === undefined ? (['profiles', 'skills'].includes(path.split('?')[0]) ? 'listed' : 'found') : path === 'skill-installations' ? 'installed' : path === 'connections/begin' ? 'started' : path === 'connections/revoke' ? 'revoked' : body.action === 'preview' ? 'previewed' : 'written';
      if (value.state !== expected) throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
      return value;
    } catch (error) {
      if (body && body.action !== 'preview') requireRefresh();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function pages(path, key) {
    var all = [],
      after = null,
      seen = new Set();
    do {
      var value = await api(path + (after ? '?after=' + encodeURIComponent(after) : ''));
      all = all.concat(value[key]);
      after = value.next_after;
      if (after && seen.has(after)) throw new Error(t('couldNotLoadTheCompleteLibraryRefreshBeforeChanging'));
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
