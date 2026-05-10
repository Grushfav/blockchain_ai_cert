import { useEffect, useMemo, useState } from "react";

/**
 * Client-side table pagination. Resets to page 1 when `resetKey` changes.
 * Clamps the current page when data shrinks.
 */
export function usePagination<T>(items: readonly T[], initialPageSize = 10, resetKey?: string | number) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialPageSize);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  useEffect(() => {
    const tp = Math.max(1, Math.ceil(items.length / pageSize));
    setPage((p) => Math.min(Math.max(1, p), tp));
  }, [items.length, pageSize]);

  const setPageSize = (n: number) => {
    setPageSizeState(n);
    setPage(1);
  };

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const pageItems = useMemo(() => items.slice(start, start + pageSize), [items, start, pageSize]);
  const from = total === 0 ? 0 : start + 1;
  const to = Math.min(start + pageSize, total);

  return { page, setPage, pageSize, setPageSize, pageItems, total, totalPages, from, to };
}
