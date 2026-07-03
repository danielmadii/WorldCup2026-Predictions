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

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const day = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
  const [tab, setTab] = useState<"value" | "builders" | "parlays">("value");
  const [bankroll, setBankroll] = useState(1000);
  const [minEdge, setMinEdge] = useState(0.03);
  const [value, setValue] = useState<ValuePick[] | null>(null);
  const [builders, setBuilders] = useState<BuilderPick[] | null>(null);
  const [parlays, setParlays] = useState<ParlayPick[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const scan = async (edge = minEdge) => {
    setBusy(true); setErr("");
    try {
      const get = async (url: string) => {
        const r = await fetch(url);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "request failed");
        return j;
      };
      const [v, c] = await Promise.all([
        get(`/api/value?minEdge=${edge}`),
        get(`/api/parlay?minEdge=${Math.max(edge, 0.05)}&maxLegs=3`),
      ]);
      setValue(v.picks);
      setBuilders(c.builders);
      setParlays(c.parlays);
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  useEffect(() => { scan(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stake = (kq: number) => `$${Math.round(bankroll * kq)}`;
  const toMake = (kq: number, odds: number) => `$${Math.round(bankroll * kq * odds)}`;
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
            <input type="number" min={0} step={100} value={bankroll}
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
        {value && value.length === 0 && <div className="note">Nothing above your edge threshold right now — try a lower minimum.</div>}
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
                      {p.date && <div className="sub">{day(p.date)}</div>}
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
                    {b.date && <time>{day(b.date)}</time>}
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
                        <span className="team">{l.match.replace(" vs ", " – ")}</span>
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
      </>}

      <p className="note" style={{ paddingLeft: 0 }}>
        Goal markets only — corners and cards trade on Cloudbet, but the model has no corners or
        cards data, so it won&apos;t pretend to price them. Edges are model estimates, not guarantees.
        Never bet more than you can afford to lose.
      </p>
    </div>
  );
}
