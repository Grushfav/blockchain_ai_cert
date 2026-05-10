const PAGE_SIZES = [10, 25, 50, 100] as const;

export function TablePagination({
  page,
  pageSize,
  totalPages,
  total,
  from,
  to,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = PAGE_SIZES,
}: {
  page: number;
  pageSize: number;
  totalPages: number;
  total: number;
  from: number;
  to: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: readonly number[];
}) {
  if (total === 0) return null;

  return (
    <div className="table-pagination" role="navigation" aria-label="Table pagination">
      <label className="table-pagination__size">
        <span className="table-pagination__size-label">Per page</span>
        <select
          className="table-pagination__select"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          aria-label="Rows per page"
        >
          {pageSizeOptions.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <span className="table-pagination__meta">
        <span className="muted small">
          {from}–{to} of {total}
        </span>
        <span className="muted small table-pagination__page">
          Page {page} / {totalPages}
        </span>
      </span>
      <div className="table-pagination__nav">
        <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
