export type PollState = { cursor: string | null; seenEventKeys: Set<string> };
export type PollResult<T> = { events: Array<{ key: string; value: T }>; nextCursor: string | null };

export function applyPollResult<T>(state: PollState, result: PollResult<T>) {
  const accepted = result.events.filter((event) => !state.seenEventKeys.has(event.key));
  for (const event of accepted) state.seenEventKeys.add(event.key);
  return { accepted, state: { cursor: result.nextCursor, seenEventKeys: state.seenEventKeys } };
}

export function renewalKey(subscriptionId: string, currentExpiry: string | null) {
  return `${subscriptionId}:${currentExpiry ?? "initial"}`;
}

export function shouldRenewSubscription(input: { status: string; renewAfter: string | null }, now = Date.now()) {
  return input.status === "active" && !!input.renewAfter && Date.parse(input.renewAfter) <= now;
}
