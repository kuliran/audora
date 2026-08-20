export interface LocalAppHandoffNavigationState {
  openLocalAppConversationId: string;
}

export function createLocalAppHandoffState(
  conversationId: string
): LocalAppHandoffNavigationState {
  return { openLocalAppConversationId: conversationId };
}

export function getLocalAppConversationUrl(conversationId: string): string {
  return `audora-local://conversation/${encodeURIComponent(conversationId)}`;
}
