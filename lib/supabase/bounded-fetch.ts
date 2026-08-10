import "server-only";

const SUPABASE_REQUEST_TIMEOUT_MS = 15_000;

export const boundedSupabaseFetch: typeof fetch = (input, init = {}) => {
  const requestSignal = input instanceof Request ? input.signal : undefined;
  const signals = [requestSignal, init.signal].filter(
    (signal): signal is AbortSignal => Boolean(signal),
  );
  const timeoutSignal = AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS);
  const signal =
    signals.length > 0
      ? AbortSignal.any([...signals, timeoutSignal])
      : timeoutSignal;

  return fetch(input, { ...init, signal });
};
