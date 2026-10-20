import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, describeError, isRouteMissing } from "../api/client.ts";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  /**
   * True when the daemon answered that it has no such route (ADR 0032): the page shows the
   * "route not available" state instead of a retry banner.
   */
  routeMissing: boolean;
  /** The HTTP status of the last failure when the daemon answered at all; null otherwise. */
  errorStatus: number | null;
  /** True while the first load or a reload is in flight. */
  loading: boolean;
  reload: () => void;
  /** Replace the data locally (optimistic updates after a mutation). */
  setData: (updater: (prev: T | null) => T | null) => void;
}

/**
 * Load data for a page. The loader receives an AbortSignal that fires on unmount and on the
 * next reload, so a late answer never overwrites a newer one.
 */
export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [routeMissing, setRouteMissing] = useState(false);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's cache key
  useEffect(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    loader(controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setData(value);
        setError(null);
        setRouteMissing(false);
        setErrorStatus(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setError(describeError(err));
        setRouteMissing(isRouteMissing(err));
        setErrorStatus(err instanceof ApiError ? err.status : null);
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const set = useCallback((updater: (prev: T | null) => T | null) => setData(updater), []);
  const state: AsyncState<T> = {
    data,
    error,
    routeMissing,
    errorStatus,
    loading,
    reload,
    setData: set,
  };
  return state;
}
