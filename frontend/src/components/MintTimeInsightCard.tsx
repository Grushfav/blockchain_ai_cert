import { Activity, Gauge, Hourglass, Info, Layers, Sparkles } from "lucide-react";
import { useMemo, type ReactNode } from "react";

export type MintTimeBand = { n: number; p50_ms: number | null; p90_ms: number | null };

export type MintTimeInsightsPayload = {
  single_mint_platform: MintTimeBand;
  batch_row_platform: MintTimeBand;
  execute_chunk_wall: MintTimeBand;
  default_execute_max_mints: number;
  computed_at_utc: string;
  note?: string;
  documentation?: Record<string, string>;
};

function fmt(ms: number | null | undefined): string {
  if (ms == null || ms < 0 || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${(s / 60).toFixed(1)} min`;
}

function BandBar({ p50, p90 }: { p50: number | null; p90: number | null }) {
  const hi = Math.max(p50 ?? 0, p90 ?? 0, 1);
  const w90 = p90 != null ? Math.min(100, (p90 / hi) * 100) : 0;
  const w50 = p50 != null ? Math.min(100, (p50 / hi) * 100) : 0;
  return (
    <div className="mint-time-insight__bar" aria-hidden>
      <div className="mint-time-insight__bar-track">
        <div className="mint-time-insight__bar-p90" style={{ width: `${w90}%` }} />
        <div className="mint-time-insight__bar-p50" style={{ width: `${w50}%` }} />
      </div>
      <div className="mint-time-insight__bar-legend">
        <span className="mint-time-insight__bar-legend-item mint-time-insight__bar-legend-item--p50">p50</span>
        <span className="mint-time-insight__bar-legend-item mint-time-insight__bar-legend-item--p90">p90</span>
      </div>
    </div>
  );
}

function MetricTile(props: {
  icon: ReactNode;
  title: string;
  band: MintTimeBand;
  doc?: string;
  accent?: "a" | "b" | "c";
}) {
  const { icon, title, band, doc, accent = "a" } = props;
  const has = band.n > 0 && (band.p50_ms != null || band.p90_ms != null);
  return (
    <div className={`mint-time-insight__tile mint-time-insight__tile--${accent}`} title={doc}>
      <div className="mint-time-insight__tile-head">
        <span className="mint-time-insight__tile-icon" aria-hidden>
          {icon}
        </span>
        <div className="mint-time-insight__tile-titles">
          <span className="mint-time-insight__tile-title">{title}</span>
          <span className="mint-time-insight__tile-n">{band.n > 0 ? `${band.n} samples` : "No samples yet"}</span>
        </div>
      </div>
      {has ? (
        <>
          <div className="mint-time-insight__readouts">
            <div className="mint-time-insight__readout mint-time-insight__readout--p50">
              <span className="mint-time-insight__readout-label">Typical</span>
              <span className="mint-time-insight__readout-value">{fmt(band.p50_ms)}</span>
            </div>
            <div className="mint-time-insight__readout mint-time-insight__readout--p90">
              <span className="mint-time-insight__readout-label">Heavy</span>
              <span className="mint-time-insight__readout-value">{fmt(band.p90_ms)}</span>
            </div>
          </div>
          <BandBar p50={band.p50_ms} p90={band.p90_ms} />
        </>
      ) : (
        <p className="mint-time-insight__tile-empty">Platform is still collecting timing for this path.</p>
      )}
    </div>
  );
}

export function MintTimeInsightCard(props: {
  insights: MintTimeInsightsPayload | null;
  loadError: string | null;
  variant: "single" | "batch";
  /** Rows used for execute-chunk ETA (see executeForecastPhase). */
  executeForecastRows?: number;
  /** projected = valid mints left before all rows prepared; ready = all prepared, sign next; minting = authorized/executing. */
  executeForecastPhase?: "projected" | "ready" | "minting" | null;
  onRetry?: () => void;
}) {
  const { insights, loadError, variant, executeForecastRows = 0, executeForecastPhase = null, onRetry } = props;
  const doc = insights?.documentation;

  const forecast = useMemo(() => {
    if (!insights || variant !== "batch") return null;
    const chunkSize = Math.max(1, insights.default_execute_max_mints || 40);
    if (executeForecastRows <= 0 || !executeForecastPhase) return null;
    const chunks = Math.ceil(executeForecastRows / chunkSize);
    const ch = insights.execute_chunk_wall;
    if (ch.n === 0 || (ch.p50_ms == null && ch.p90_ms == null)) {
      return { chunks, chunkSize, p50Total: null as number | null, p90Total: null as number | null };
    }
    const p50Total = ch.p50_ms != null ? Math.round(ch.p50_ms * chunks) : null;
    const p90Total = ch.p90_ms != null ? Math.round(ch.p90_ms * chunks) : null;
    return { chunks, chunkSize, p50Total, p90Total };
  }, [insights, variant, executeForecastRows, executeForecastPhase]);

  if (loadError) {
    return (
      <div className="mint-time-insight mint-time-insight--unavailable" role="status">
        <span className="mint-time-insight__unavailable-icon" aria-hidden>
          <Info size={18} strokeWidth={2.25} />
        </span>
        <div className="mint-time-insight__unavailable-body">
          <p className="mint-time-insight__unavailable-title">Live timing estimates unavailable</p>
          <p className="mint-time-insight__unavailable-lead">
            Minting still works — this panel only needs the public timing endpoint on your API host.
          </p>
          {onRetry ? (
            <button type="button" className="mint-time-insight__retry" onClick={onRetry}>
              Try again
            </button>
          ) : null}
          <details className="mint-time-insight__unavailable-details">
            <summary>Technical detail</summary>
            <p className="mint-time-insight__unavailable-tech">{loadError}</p>
          </details>
        </div>
      </div>
    );
  }

  if (!insights) {
    return (
      <div className="mint-time-insight mint-time-insight--loading" aria-busy="true">
        <span className="mint-time-insight__shimmer" />
        <span className="mint-time-insight__shimmer mint-time-insight__shimmer--short" />
      </div>
    );
  }

  return (
    <aside className={`mint-time-insight mint-time-insight--${variant}`} aria-label="Platform mint timing insights">
      <div className="mint-time-insight__glow" aria-hidden />
      <header className="mint-time-insight__header">
        <div className="mint-time-insight__header-main">
          <span className="mint-time-insight__badge" aria-hidden>
            <Sparkles size={14} strokeWidth={2.25} />
          </span>
          <div>
            <h3 className="mint-time-insight__heading">Mint Traffic</h3>
            <p className="mint-time-insight__sub">
              Global p50 and p90 from recent mints (UTC{" "}
              {insights.computed_at_utc.replace(/(\.\d+)?Z$/i, "").replace("T", " ")}).
            </p>
          </div>
        </div>
      </header>

      {variant === "single" ? (
        <div className="mint-time-insight__hero">
          <div className="mint-time-insight__hero-label">
            <Hourglass size={16} aria-hidden /> Single certificate (after you sign)
          </div>
          <div className="mint-time-insight__hero-values">
            <div className="mint-time-insight__hero-p50">
              <span className="mint-time-insight__hero-k">Typical</span>
              <span className="mint-time-insight__hero-v">{fmt(insights.single_mint_platform.p50_ms)}</span>
            </div>
            <div className="mint-time-insight__hero-p90">
              <span className="mint-time-insight__hero-k">Heavy load</span>
              <span className="mint-time-insight__hero-v">{fmt(insights.single_mint_platform.p90_ms)}</span>
            </div>
          </div>
          <BandBar p50={insights.single_mint_platform.p50_ms} p90={insights.single_mint_platform.p90_ms} />
          <p className="mint-time-insight__hero-foot">
            {insights.single_mint_platform.n > 0
              ? `Based on ${insights.single_mint_platform.n} completed single mints.`
              : "Not enough completed single mints yet for a percentile band."}
          </p>
        </div>
      ) : (
        <>
          <div className="mint-time-insight__grid">
            <MetricTile
              accent="a"
              icon={<Hourglass size={17} strokeWidth={2} />}
              title="Single mint (reference)"
              band={insights.single_mint_platform}
              doc={doc?.single_mint_platform}
            />
            <MetricTile
              accent="b"
              icon={<Layers size={17} strokeWidth={2} />}
              title="Batch: per row (server)"
              band={insights.batch_row_platform}
              doc={doc?.batch_row_platform}
            />
            <MetricTile
              accent="c"
              icon={<Activity size={17} strokeWidth={2} />}
              title={`Execute chunk (wall, ≤${insights.default_execute_max_mints} rows)`}
              band={insights.execute_chunk_wall}
              doc={doc?.execute_chunk_wall}
            />
          </div>

          {forecast && (
            <div
              className={`mint-time-insight__forecast ${
                forecast.p50Total == null && forecast.p90Total == null ? "mint-time-insight__forecast--muted" : ""
              } ${executeForecastPhase === "projected" ? "mint-time-insight__forecast--projected" : ""}`}
            >
              <div className="mint-time-insight__forecast-head">
                <Gauge size={16} aria-hidden />
                <span>
                  {executeForecastPhase === "projected" ? (
                    <>
                      Up to <strong>{executeForecastRows}</strong> valid row{executeForecastRows === 1 ? "" : "s"} still
                      to mint after <strong>every row is prepared</strong> → about <strong>{forecast.chunks}</strong>{" "}
                      execute run{forecast.chunks === 1 ? "" : "s"} (≤{forecast.chunkSize} mints per click)
                    </>
                  ) : executeForecastPhase === "ready" ? (
                    <>
                      <strong>{executeForecastRows}</strong> row{executeForecastRows === 1 ? "" : "s"} prepared — sign
                      the batch, then run execute (about <strong>{forecast.chunks}</strong> run
                      {forecast.chunks === 1 ? "" : "s"}, ≤{forecast.chunkSize} per click)
                    </>
                  ) : (
                    <>
                      <strong>{executeForecastRows}</strong> certificate{executeForecastRows === 1 ? "" : "s"} still
                      queued for execute → about <strong>{forecast.chunks}</strong> run{forecast.chunks === 1 ? "" : "s"}{" "}
                      (≤{forecast.chunkSize} per click)
                    </>
                  )}
                </span>
              </div>
              {forecast.p50Total != null || forecast.p90Total != null ? (
                <p className="mint-time-insight__forecast-body">
                  {executeForecastPhase === "projected" ? (
                    <>
                      Rough on-platform wait after full preparation (chunk timing from recent batches; signing not
                      included): <strong>{fmt(forecast.p50Total)}</strong> typical, <strong>{fmt(forecast.p90Total)}</strong>{" "}
                      heavier tail.
                    </>
                  ) : (
                    <>
                      Rough remaining on-platform wait from chunk timing: <strong>{fmt(forecast.p50Total)}</strong>{" "}
                      typical, <strong>{fmt(forecast.p90Total)}</strong> heavier — plus wallet time between runs.
                    </>
                  )}
                </p>
              ) : (
                <p className="mint-time-insight__forecast-body">
                  Chunk timing will appear here after the platform records a few execute batches.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {insights.note ? <p className="mint-time-insight__note">{insights.note}</p> : null}
    </aside>
  );
}
