/** Pending bridge IDs are persisted with the socket attachment.
 * Timeouts must not erase IDs: a late reply is still execution evidence. */
export interface BridgePendingAttachment {
  pendingUpdateRpcIds?: string[];
}

export function pendingBridgeCount(attachment: BridgePendingAttachment): number {
  return attachment.pendingUpdateRpcIds?.length ?? 0;
}

export function rememberPendingBridge(attachment: BridgePendingAttachment, id: string): void {
  attachment.pendingUpdateRpcIds = [...(attachment.pendingUpdateRpcIds ?? []), id];
}

export function forgetPendingBridge(attachment: BridgePendingAttachment, id: string): void {
  attachment.pendingUpdateRpcIds = (attachment.pendingUpdateRpcIds ?? []).filter(current => current !== id);
}
