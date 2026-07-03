"use client";
import { useEffect, useMemo, useState } from "react";

type ValuePick = {
  match: string; date?: string; bet: string;
  odds: number; modelProb: number; impliedProb: number;
  ev: number; kellyQuarter: number;
};
type BuilderPick = {
  match: string; date?: string;
  legs: { label: string; odds: number; modelProb: number }[];
  combinedOdds: number; modelProb: number; fairOdds: number;
  correlation: number; ev: number; kellyQuarter: number;
};
type ParlayPick = {
  legs: { match: string; label: string; odds: number; modelProb: number; date?: string }[];
  combinedOdds: number; modelProb: number; impliedProb: number;
  ev: number; kellyQuarter: number;
};
type Anomaly = {
  match: string; date?: string; live: boolean;
  kind: "arb" | "contradiction" | "mispriced-pair";
  note: string; edge: number;
};
type MatchInfo = { id: number; home: string; away: string; date?: string; live?: boolean };

// all times come from Cloudbet's cutoffTime (UTC) and render in Beirut time,
// both for display and for the date-range filter
const TZ = "Asia/Beirut";
const localYMD = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
};

const KIND_LABEL: Record<Anomaly["kind"], string> = {
  arb: "Arbitrage",
  contradiction: "Contradiction",
  "mispriced-pair": "Mispriced pair",
};

const pct = (x: number) => `${(100 * x).toFixed(x < 0.01 ? 2 : 1)}%`;
const xOdds = (o: number) => (o >= 1000 ? Math.round(o).toLocaleString("en-US") : o.toFixed(2));
const when = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time}`;
};

type SortKey = "odds" | "modelProb" | "ev" | "stake" | "toMake";
type ComboSort = "ev" | "modelProb" | "combinedOdds";

const COMBO_SORTS: [ComboSort, string][] = [
  ["ev", "Best edge"],
  ["modelProb", "Best win chance"],
  ["combinedOdds", "Biggest payout"],
];

function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <i key={i} style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export default function Page() {
  const [tab, setTab] = useState<"value" | "builders" | "parlays" | "yolo" | "anoms">("value");
  const [bankroll, setBankroll] = useState(10);
  const [minEdge, setMinEdge] = useState(0.03);
  const [value, setValue] = useState<ValuePick[] | null>(null);
  const [builders, setBuilders] = useState<BuilderPick[] | null>(null);
  const [parlays, setParlays] = useState<ParlayPick[] | null>(null);
  const [yolo, setYolo] = useState<ParlayPick[] | null>(null);
  const [anoms, setAnoms] = useState<Anomaly[] | null>(null);
  const [matches, setMatches] = useState<MatchInfo[] | null>(null);
  const [sel, setSel] = useState<Set<number> | null>(null); // null = all matches
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const inRange = (m: MatchInfo) => {
    const d = localYMD(m.date);
    const swap = fromDate && toDate && fromDate > toDate;
    const lo = swap ? toDate : fromDate;
    const hi = swap ? fromDate : toDate;
    return (!lo || d >= lo) && (!hi || d <= hi);
  };
  const [autoRef, setAutoRef] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const scan = async (edge = minEdge, selected = sel) => {
    setBusy(true); setErr("");
    try {
      const get = async (url: string) => {
        const r = await fetch(url);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "request failed");
        return j;
      };
      let ids = "";
      if (matches && (selected || fromDate || toDate)) {
        const bettable = matches.filter((m) => !m.live);
        const chosen = bettable.filter((m) => inRange(m) && (!selected || selected.has(m.id))).map((m) => m.id);
        // "-1" forces an empty board rather than silently scanning everything
        ids = chosen.length === bettable.length ? "" : `&ids=${chosen.length ? chosen.join(",") : "-1"}`;
      }
      const [v, c, a, m] = await Promise.all([
        get(`/api/value?minEdge=${edge}${ids}`),
        get(`/api/parlay?minEdge=${Math.max(edge, 0.05)}&maxLegs=3${ids}`),
        get(`/api/anomalies`),
        get(`/api/matches`),
      ]);
      setValue(v.picks);
      setBuilders(c.builders);
      setParlays(c.parlays);
      setYolo(c.yolo);
      setAnoms(a.anomalies);
      setMatches(m.matches);
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  useEffect(() => { scan(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // anomalies decay fast — poll while the tab is open
  useEffect(() => {
    if (tab !== "anoms" || !autoRef) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch("/api/anomalies");
        const j = await r.json();
        if (r.ok) setAnoms(j.anomalies);
      } catch {}
    }, 60_000);
    return () => clearInterval(t);
  }, [tab, autoRef]);

  const money = (x: number) => `$${x >= 20 ? Math.round(x) : x.toFixed(2)}`;
  const stake = (kq: number) => money(bankroll * kq);
  const toMake = (kq: number, odds: number) => money(bankroll * kq * odds);
  const maxEv = useMemo(() => Math.max(0.001, ...(value ?? []).map((p) => p.ev)), [value]);
  const needsKey = err.includes("CLOUDBET_API_KEY");
  const loading = busy && !err;

  const [sort, setSort] = useState<{ k: SortKey; d: 1 | -1 }>({ k: "ev", d: -1 });
  const sortedValue = useMemo(() => {
    if (!value) return null;
    const v = (p: ValuePick) =>
      sort.k === "stake" ? p.kellyQuarter : sort.k === "toMake" ? p.kellyQuarter * p.odds : p[sort.k];
    return [...value].sort((a, b) => (v(a) - v(b)) * sort.d);
  }, [value, sort]);
  const onSort = (k: SortKey) =>
    setSort((s) => ({ k, d: s.k === k ? (-s.d as 1 | -1) : -1 }));

  const [builderSort, setBuilderSort] = useState<ComboSort>("ev");
  const [parlaySort, setParlaySort] = useState<ComboSort>("ev");
  const sortedBuilders = useMemo(
    () => builders && [...builders].sort((a, b) => b[builderSort] - a[builderSort]),
    [builders, builderSort]
  );
  const sortedParlays = useMemo(
    () => parlays && [...parlays].sort((a, b) => b[parlaySort] - a[parlaySort]),
    [parlays, parlaySort]
  );

  const Th = ({ k, label, left }: { k: SortKey; label: string; left?: boolean }) => (
    <th className={left ? "" : "num"} aria-sort={sort.k === k ? (sort.d === -1 ? "descending" : "ascending") : undefined}>
      <button className="sortbtn" onClick={() => onSort(k)}>
        {label} <span className="arrow">{sort.k === k ? (sort.d === -1 ? "▼" : "▲") : "⇅"}</span>
      </button>
    </th>
  );

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>WC26 <span>Value Desk</span></h1>
        <p className="tagline">
          A model prices every World Cup match from 150 years of results. When Cloudbet
          pays more than the model&apos;s fair price, the bet shows up here.
        </p>
      </header>

      <section className="panel">
        <div className="toolbar">
          <label className="field">Bankroll $
            <input type="number" min={0} step={10} value={bankroll}
              onChange={(e) => setBankroll(Number(e.target.value))} />
          </label>
          <label className="field">Min edge
            <select value={minEdge} onChange={(e) => { const v = Number(e.target.value); setMinEdge(v); scan(v); }}>
              <option value={0.02}>+2% — show more</option>
              <option value={0.03}>+3% — balanced</option>
              <option value={0.05}>+5% — solid only</option>
              <option value={0.08}>+8% — strongest</option>
            </select>
          </label>
          <label className="field">From
            <input type="date" value={fromDate}
              onChange={(e) => { setFromDate(e.target.value); setSel(null); }} />
          </label>
          <label className="field">To
            <input type="date" value={toDate}
              onChange={(e) => { setToDate(e.target.value); setSel(null); }} />
          </label>
          <div className="spacer" />
          <button className="btn" onClick={() => scan()} disabled={busy}>
            {busy ? "Scanning…" : "Rescan"}
          </button>
        </div>
        <dl className="howto">
          <div>
            <dt>Odds</dt>
            <dd>What Cloudbet pays per $1 if the bet wins.</dd>
          </div>
          <div>
            <dt>Win chance</dt>
            <dd>How often the model thinks this bet wins.</dd>
          </div>
          <div>
            <dt>Edge</dt>
            <dd>Average profit if you made this bet many times. +5% ≈ $5 per $100 staked. A bigger edge is a better price — not a safer bet.</dd>
          </div>
          <div>
            <dt>Bet</dt>
            <dd>Suggested stake (¼ Kelly of bankroll) — sized so a losing streak can&apos;t sink you.</dd>
          </div>
          <div>
            <dt>To make</dt>
            <dd>What comes back if the bet wins — bet × odds, your stake included.</dd>
          </div>
        </dl>
        {matches && matches.length > 0 && (() => {
          const pool = matches.filter(inRange);
          const bettable = pool.filter((m) => !m.live);
          const nSel = bettable.filter((m) => !sel || sel.has(m.id)).length;
          return (
            <details className="picker">
              <summary>
                Matches — {nSel} of {bettable.length} selected
                {(fromDate || toDate) && <span className="hint">date filter on · {matches.length - pool.length} hidden</span>}
                {!fromDate && !toDate && <span className="hint">pick the games you want bets on, then Rescan</span>}
              </summary>
              <div className="pickbar">
                <button className="btn ghost" onClick={() => setSel(null)}>All</button>
                <button className="btn ghost" onClick={() => setSel(new Set())}>None</button>
              </div>
              {pool.length === 0 && <div className="note">No matches between those dates — widen the range.</div>}
              <div className="pickgrid">
                {pool.map((m) =>
                  m.live ? (
                    <span key={m.id} className="pick islive" title="In play — the model only prices matches before kickoff">
                      <span className="sub">{when(m.date)}</span>
                      <span>{m.home} vs {m.away}</span>
                      <span className="pill-live">LIVE</span>
                    </span>
                  ) : (
                    (() => {
                      const on = sel ? sel.has(m.id) : true;
                      return (
                        <label key={m.id} className={`pick ${on ? "on" : ""}`}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => {
                              const next = new Set(sel ?? bettable.map((x) => x.id));
                              if (on) next.delete(m.id);
                              else next.add(m.id);
                              setSel(next.size === bettable.length ? null : next);
                            }}
                          />
                          <span className="sub">{when(m.date)}</span>
                          <span>{m.home} vs {m.away}</span>
                        </label>
                      );
                    })()
                  )
                )}
              </div>
            </details>
          );
        })()}
      </section>

      {needsKey && (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="setup">
            <h2>Connect Cloudbet to start</h2>
            <ol>
              <li>Log in at cloudbet.com → <b>My Account → API</b> and copy your API key.</li>
              <li>Create <code>.env.local</code> in the project with <code>CLOUDBET_API_KEY=your-key</code>.</li>
              <li>Restart the app and hit <b>Rescan</b>.</li>
            </ol>
          </div>
        </section>
      )}
      {err && !needsKey && (
        <section className="panel" style={{ marginTop: 16 }}><div className="err">{err}</div></section>
      )}

      {!needsKey && <>
      <nav className="tabs" aria-label="Sections">
        {([
          ["value", "Value bets", value?.length],
          ["builders", "Bet builders", builders?.length],
          ["parlays", "Parlays", parlays?.length],
          ["yolo", "YOLO bets", yolo?.length],
          ["anoms", "Anomalies", anoms?.length],
        ] as const).map(([k, label, n]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {label}{n !== undefined && <span className="count">{n}</span>}
          </button>
        ))}
      </nav>

      {tab === "value" && (
      <section className="panel">
        <div className="head">Value bets <small>single bets where the price beats the model</small></div>
        {loading && !value && <Skeleton rows={5} />}
        {value && value.length === 0 && (
          <div className="note">
            {matches && matches.length === 0
              ? <>Cloudbet returned no upcoming World Cup matches — open <code>/api/debug</code> to see what the feed contains.</>
              : "Nothing above your edge threshold right now — try a lower minimum."}
          </div>
        )}
        {sortedValue && sortedValue.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="board">
              <thead>
                <tr>
                  <th>Match</th><th>Bet</th>
                  <Th k="odds" label="Odds" />
                  <Th k="modelProb" label="Win chance" />
                  <Th k="ev" label="Edge" left />
                  <Th k="stake" label="Bet" />
                  <Th k="toMake" label="To make" />
                </tr>
              </thead>
              <tbody>
                {sortedValue.map((p, i) => (
                  <tr key={`${p.match}-${p.bet}`}>
                    <td>
                      <div className="team">{p.match}</div>
                      {p.date && <div className="sub">{when(p.date)}</div>}
                    </td>
                    <td>{p.bet}</td>
                    <td className="num">{p.odds.toFixed(2)}</td>
                    <td className="num">{pct(p.modelProb)}</td>
                    <td className="edgecell">
                      <div className="edgeval">+{(100 * p.ev).toFixed(1)}%</div>
                      <div className="meter"><span style={{ width: `${(p.ev / maxEv) * 100}%` }} /></div>
                    </td>
                    <td className="num">{stake(p.kellyQuarter)}</td>
                    <td className="num">{toMake(p.kellyQuarter, p.odds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}

      {tab === "builders" && (
      <section className="panel">
        <div className="head">
          Bet builders <small>combos inside one match — legs rise and fall together</small>
          {builders && builders.length > 1 && (
            <select className="mini" value={builderSort} onChange={(e) => setBuilderSort(e.target.value as ComboSort)}>
              {COMBO_SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          )}
        </div>
        {loading && !builders && <Skeleton rows={3} />}
        {builders && builders.length === 0 && <div className="note">No same-game combos above the edge threshold.</div>}
        {sortedBuilders && sortedBuilders.length > 0 && (
          <>
            <div className="slipgrid">
              {sortedBuilders.map((b, i) => (
                <article className="slip" key={i}>
                  <div className="sliphead">
                    <span className="team">{b.match}</span>
                    {b.date && <time>{when(b.date)}</time>}
                  </div>
                  <ul className="legs">
                    {b.legs.map((l, j) => (
                      <li key={j}><span>{l.label}</span><span className="lodds">@{l.odds.toFixed(2)}</span></li>
                    ))}
                  </ul>
                  <div className="slipfoot">
                    <div className="stat"><label>Odds</label><b>{b.combinedOdds.toFixed(2)}</b></div>
                    <div className="stat"><label>Fair</label><b>{b.fairOdds.toFixed(2)}</b></div>
                    <div className="stat"><label>Win chance</label><b>{pct(b.modelProb)}</b></div>
                    <div className="stat"><label>Edge</label><b className="chip">+{(100 * b.ev).toFixed(0)}%</b></div>
                    <div className="stat"><label>Bet</label><b>{stake(b.kellyQuarter)}</b></div>
                    <div className="stat"><label>To make</label><b>{toMake(b.kellyQuarter, b.combinedOdds)}</b></div>
                  </div>
                </article>
              ))}
            </div>
            <div className="note">
              Odds here multiply the single prices. Cloudbet&apos;s real bet-builder quote reprices
              linked legs — build the slip on their site and only bet if their quote is at or above <b>Fair</b>.
              Corners and cards legs are priced from the market itself (margin removed): they add variety,
              not edge — any edge shown comes from the goal legs.
            </div>
          </>
        )}
      </section>
      )}

      {tab === "parlays" && (
      <section className="panel">
        <div className="head">
          Parlays <small>combos across matches — all legs must win</small>
          {parlays && parlays.length > 1 && (
            <select className="mini" value={parlaySort} onChange={(e) => setParlaySort(e.target.value as ComboSort)}>
              {COMBO_SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          )}
        </div>
        {loading && !parlays && <Skeleton rows={3} />}
        {parlays && parlays.length === 0 && <div className="note">No qualifying legs right now.</div>}
        {sortedParlays && sortedParlays.length > 0 && (
          <div className="slipgrid">
            {sortedParlays.map((p, i) => (
              <article className="slip" key={i}>
                <div className="sliphead">
                  <span className="team">{p.legs.length}-leg parlay</span>
                  <time>pays {p.combinedOdds.toFixed(2)}×</time>
                </div>
                <ul className="legs">
                  {p.legs.map((l, j) => (
                    <li key={j}>
                      <span>
                        <span className="team">{l.match.replace(" vs ", " – ")}</span>{l.date && <span className="sub"> {when(l.date)}</span>}
                        <br />{l.label}
                      </span>
                      <span className="lodds">@{l.odds.toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
                <div className="slipfoot">
                  <div className="stat"><label>Odds</label><b>{p.combinedOdds.toFixed(2)}</b></div>
                  <div className="stat"><label>Win chance</label><b>{pct(p.modelProb)}</b></div>
                  <div className="stat"><label>Edge</label><b className="chip">+{(100 * p.ev).toFixed(0)}%</b></div>
                  <div className="stat"><label>Bet</label><b>{stake(p.kellyQuarter)}</b></div>
                  <div className="stat"><label>To make</label><b>{toMake(p.kellyQuarter, p.combinedOdds)}</b></div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      )}

      {tab === "yolo" && (
      <section className="panel">
        <div className="head">
          YOLO bets <small>1,000×+ lottery tickets built from the model&apos;s smartest legs</small>
        </div>
        {loading && !yolo && <Skeleton rows={3} />}
        {yolo && yolo.length === 0 && (
          <div className="note">The selected matches can&apos;t multiply to 1,000× even with longshot legs — select more matches or widen the date range.</div>
        )}
        {yolo && yolo.length > 0 && (
          <>
            <div className="slipgrid">
              {yolo.map((p, i) => (
                <article className="slip" key={i}>
                  <div className="sliphead">
                    <span className="team">{p.legs.length}-leg YOLO</span>
                    <time>pays {xOdds(p.combinedOdds)}×</time>
                  </div>
                  <ul className="legs">
                    {p.legs.map((l, j) => (
                      <li key={j}>
                        <span>
                          <span className="team">{l.match.replace(" vs ", " – ")}</span>{l.date && <span className="sub"> {when(l.date)}</span>}
                          <br />{l.label}
                        </span>
                        <span className="lodds">@{l.odds.toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="slipfoot">
                    <div className="stat"><label>Odds</label><b>{xOdds(p.combinedOdds)}</b></div>
                    <div className="stat"><label>Win chance</label><b>{pct(p.modelProb)}</b></div>
                    <div className="stat"><label>Fair</label><b>{xOdds(1 / p.modelProb)}</b></div>
                    <div className="stat"><label>Edge</label><b className="chip">+{(100 * p.ev).toFixed(0)}%</b></div>
                    <div className="stat"><label>$1 pays</label><b>${xOdds(p.combinedOdds)}</b></div>
                  </div>
                </article>
              ))}
            </div>
            <div className="note">
              This is a lottery ticket, engineered: the legs lean toward the model&apos;s picks, but at
              1,000× nothing is safe — expect to lose this ~99% of the time. Stake pocket change
              you&apos;d happily burn for the sweat.
            </div>
          </>
        )}
      </section>
      )}

      {tab === "anoms" && (
      <section className="panel">
        <div className="head">
          Anomalies <small>pricing errors on the board — live and pre-match</small>
          <label className="check">
            <input type="checkbox" checked={autoRef} onChange={(e) => setAutoRef(e.target.checked)} />
            auto-refresh 60s
          </label>
        </div>
        {loading && !anoms && <Skeleton rows={4} />}
        {anoms && anoms.length === 0 && (
          <div className="note">
            No pricing errors right now — the book is internally consistent. Errors surface most
            during live matches; keep auto-refresh on while games are playing.
          </div>
        )}
        {anoms && anoms.length > 0 && (
          <>
            <div style={{ overflowX: "auto" }}>
              <table className="board">
                <thead>
                  <tr>
                    <th>Match</th><th>Type</th><th>What&apos;s wrong</th><th className="num">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {anoms.map((a, i) => (
                    <tr key={i}>
                      <td>
                        <span className="team">{a.match}</span>
                        {a.live && <span className="pill-live">LIVE</span>}
                        {a.date && !a.live && <div className="sub">{when(a.date)}</div>}
                      </td>
                      <td><span className="chip">{KIND_LABEL[a.kind]}</span></td>
                      <td style={{ maxWidth: 420 }}>{a.note}</td>
                      <td className="num">
                        {a.kind === "arb"
                          ? `+${(100 * a.edge).toFixed(2)}% locked`
                          : `${(100 * a.edge).toFixed(1)}pp gap`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="note">
              <b>Arbitrage</b>: backing every outcome returns a profit whatever happens.{" "}
              <b>Contradiction</b>: an outcome priced more likely than another it logically implies.{" "}
              <b>Mispriced pair</b>: two bets that settle identically at different prices — take the bigger one.
              Verify on Cloudbet before betting: these vanish in seconds, and an Affiliate API key
              lags up to a minute behind the real board (use a Trading key for this tab).
            </div>
          </>
        )}
      </section>
      )}
      </>}

      <p className="note" style={{ paddingLeft: 0 }}>
        The model predicts goals — corners and cards appear in bet builders priced from Cloudbet&apos;s
        own market with the margin removed, so no fake edge is ever claimed on them; they stay out of
        value bets and parlays. Edges are model estimates, not guarantees. Never bet more than you can
        afford to lose.
      </p>
    </div>
  );
}
