const remoteMessages = Object.freeze({ remote_upstream_unavailable: 'mcpServiceUnavailable',
  remote_upstream_protocol_error: 'mcpResponseInvalid', remote_result_invalid: 'mcpResponseInvalid',
  remote_dependency_unavailable: 'mcpConnectionUnavailable' });

/** Classify failure receipts into guidance and recovery metadata; the API owns refresh admission. */
export function classifyCentralFailure({ serviceInput, skillInput, skillInstallation, sourceAction, inspection, registry }, status, value) {
  const code = value.error && value.error.code;
  const notStarted = value.error?.operation_state === 'not_started';
  const confirmedInput = status === 400 && notStarted
    && (serviceInput && ['central_invalid_request', 'central_invalid'].includes(code)
      || skillInstallation && ['central_invalid_request', 'skill_invalid_package', 'skill_invalid'].includes(code));
  const failure = messageKey => ({ messageKey, confirmedNotStarted: confirmedInput });

  // Guidance describes a verified failure category; mutation admission remains separate.
  if (notStarted && status === 404 && code === 'central_disabled') return failure('centralSetupRequired');
  if (notStarted && status === 429 && code === 'remote_busy') return failure('mcpBusy');
  if (notStarted && status === 503 && code === 'central_authority_unavailable') return failure('sessionVerificationUnavailable');
  if (status === 503 && code === 'remote_operation_timed_out') return failure(notStarted ? 'mcpTimedOut' : 'mcpTimeoutUnconfirmed');
  const remoteMessage = typeof code === 'string' && Object.hasOwn(remoteMessages, code) ? remoteMessages[code] : undefined;
  if (status === 503 && remoteMessage && (notStarted || value.error?.operation_state === 'unknown'))
    return failure(remoteMessage + (notStarted ? '' : 'Unconfirmed'));
  if (status === 503 && code === 'remote_egress_denied' && notStarted)
    return failure('enterAPublicHttpsMcpUrlPrivateAddressesAnd');

  // Only an explicit, recognized not-started receipt leaves a write ready for correction.
  if (status === 413 && skillInput && code === 'central_request_too_large' && notStarted)
    return { messageKey: 'skillUploadTooLarge', confirmedNotStarted: true };
  if (status === 429 && (skillInstallation || sourceAction === 'install') && code === 'skill_capacity' && notStarted)
    return { messageKey: 'skillLibraryLimitReached', confirmedNotStarted: true, details: { skillCapacity: true } };
  if (status === 409 && skillInstallation && value.state === 'conflict')
    return { message: 'skill_exists', confirmedNotStarted: false, details: { skillId: value.skill_id, revision: value.current_revision } };
  if (code === 'skill_lifecycle_expired') return failure('skillCleanupExpired');
  if (code === 'skill_lifecycle_protected') return failure('skillCleanupProtected');
  if (sourceAction && code === 'skill_source_busy' && notStarted)
    return { messageKey: 'skillSourceBusy', confirmedNotStarted: true };
  const sourceError = sourceAction && { skill_source_invalid: 'skillSourceInvalid', skill_source_missing: 'skillSourceMissing',
    skill_source_capacity: 'skillSourceCapacity', skill_source_changed: 'skillSourceChanged', skill_source_unavailable: 'skillSourceUnavailable' }[code];
  if (sourceError) return failure(sourceError);
  if (inspection) return failure(status === 400 ? 'checkServiceNameAndPublicMcpUrl' : status === 403 ? 'accessWasDeniedSignInAgainOrCheckThe' : 'inspectionFailed');
  if (registry && code === 'registry_invalid_entry') return failure('registryInvalidEntry');
  if (status === 409) return failure('thisItemChangedRefreshAndReviewItAgainBefore');
  if (status === 403) return failure('accessWasDeniedSignInAgainOrCheckThe');
  if (status === 400) return failure(serviceInput ? 'checkServiceNameAndPublicMcpUrl' : skillInput ? 'checkSkillFilesRequireNameAndDescription' : 'invalidActionRefreshLibrary');
  if (code === 'oauth_provider_unsupported') return failure('thisServiceDoesNotSupportAutomaticOauthConnectionCheck');
  if (code === 'oauth_configuration_required') return failure('oauthConfigurationRequired');
  if (code === 'remote_authorization_required' || code === 'oauth_reauthorization_required') return failure('signInToThisServiceAgainUsingReconnect');
  if (code === 'oauth_unavailable') return failure('authorizationCouldNotBeCompletedRefreshAndReconnectIf');
  if (code === 'remote_egress_denied' || code === 'remote_endpoint_denied') return failure('enterAPublicHttpsMcpUrlPrivateAddressesAnd');
  return failure('operationCouldNotBeConfirmedRefreshTheCurrentState');
}
