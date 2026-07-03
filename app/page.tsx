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
  legs: { match: string; label: string; odds: number; modelProb: number }[];
  combinedOdds: number; modelProb: number; impliedProb: number;
  ev: number; kellyQuarter: number;
};

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

export default function Page() {
  const [bankroll, setBankroll] = useState(1000);
  const [minEdge, setMinEdge] = useState(0.03);
  const [value, setValue] = useState<ValuePick[] | null>(null);
  const [builders, setBuilders] = useState<BuilderPick[] | null>(null);
  const [parlays, setParlays] = useState<ParlayPick[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const scan = async () => {
    setBusy(true); setErr("");
    try {
      const [v, c] = await Promise.all([
        fetch(`/api/value?minEdge=${minEdge}`).then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j.error ?? "request failed");
          return j;
        }),
        fetch(`/api/parlay?minEdge=${Math.max(minEdge, 0.05)}&maxLegs=3`).then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j.error ?? "request failed");
          return j;
        }),
      ]);
      setValue(v.picks);
      setBuilders(c.builders);
      setParlays(c.parlays);
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  useEffect(() => { scan(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stake = (kq: number) => `$${(bankroll * kq).toFixed(0)}`;
  const maxEv = useMemo(() => Math.max(0.001, ...(value ?? []).map((p) => p.ev)), [value]);

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>WC26 <span>Value Desk</span></h1>
        <div className="meta">
          model vs Cloudbet · 1X2, handicaps, totals,<br />
          team totals, BTTS, double chance, draw no bet
        </div>
      </header>

      <section className="panel">
        <div className="controls">
          <label className="field">Bankroll $
            <input type="number" min={0} step={100} value={bankroll}
              onChange={(e) => setBankroll(Number(e.target.value))} />
          </label>
          <label className="field">Min edge
            <input type="number" step={0.01} min={0} max={0.5} value={minEdge}
              onChange={(e) => setMinEdge(Number(e.target.value))} />
          </label>
          <button className="btn" onClick={scan} disabled={busy}>
            {busy ? "Scanning…" : "Scan"}
          </button>
        </div>
        {err && (
          <div className="err">
            {err}
            {err.includes("CLOUDBET_API_KEY") && " — add it to .env.local or Vercel → Settings → Environment Variables."}
          </div>
        )}
        {busy && !err && <div className="note">Training model and scanning Cloudbet markets…</div>}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="head">Value bets — single selections</div>
        {value && value.length === 0 && <div className="note">Nothing above the edge threshold right now.</div>}
        {value && value.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="board">
              <thead>
                <tr>
                  <th>Match</th><th>Bet</th>
                  <th className="num">Odds</th><th className="num">Model</th>
                  <th>Edge</th><th className="num">Stake</th>
                </tr>
              </thead>
              <tbody>
                {value.map((p, i) => (
                  <tr key={i}>
                    <td className="team">{p.match}</td>
                    <td>{p.bet}</td>
                    <td className="num">{p.odds.toFixed(2)}</td>
                    <td className="num">{pct(p.modelProb)}</td>
                    <td className="evcell">
                      <span className="evbar" style={{ width: `${(p.ev / maxEv) * 100}%` }} />
                      <span className="evtxt">+{(100 * p.ev).toFixed(1)}%</span>
                    </td>
                    <td className="num">{stake(p.kellyQuarter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="head">Bet builders — same game</div>
        {builders && builders.length === 0 && <div className="note">No same-game combos above the edge threshold.</div>}
        {builders && builders.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="board">
              <thead>
                <tr>
                  <th>Match</th><th>Legs</th>
                  <th className="num">Odds*</th><th className="num">Model</th>
                  <th className="num">Fair</th><th className="num">Edge</th><th className="num">Stake</th>
                </tr>
              </thead>
              <tbody>
                {builders.map((b, i) => (
                  <tr key={i}>
                    <td className="team">{b.match}</td>
                    <td>{b.legs.map((l, j) => <div key={j}>{l.label} <span style={{ opacity: 0.55 }}>@{l.odds.toFixed(2)}</span></div>)}</td>
                    <td className="num">{b.combinedOdds.toFixed(2)}</td>
                    <td className="num">{pct(b.modelProb)}</td>
                    <td className="num">{b.fairOdds.toFixed(2)}</td>
                    <td className="num evtxt">+{(100 * b.ev).toFixed(1)}%</td>
                    <td className="num">{stake(b.kellyQuarter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {builders && builders.length > 0 && (
          <div className="note">
            * Product of single prices — Cloudbet&apos;s actual bet-builder quote reprices correlated legs.
            Only bet if their quote is at or above the Fair column.
          </div>
        )}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="head">Parlays — across matches</div>
        {parlays && parlays.length === 0 && <div className="note">No qualifying legs right now.</div>}
        {parlays && parlays.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="board">
              <thead>
                <tr>
                  <th>Legs</th>
                  <th className="num">Odds</th><th className="num">Model</th>
                  <th className="num">Edge</th><th className="num">Stake</th>
                </tr>
              </thead>
              <tbody>
                {parlays.map((p, i) => (
                  <tr key={i}>
                    <td>{p.legs.map((l, j) => (
                      <div key={j}><span className="team">{l.match}</span> — {l.label} <span style={{ opacity: 0.55 }}>@{l.odds.toFixed(2)}</span></div>
                    ))}</td>
                    <td className="num">{p.combinedOdds.toFixed(2)}</td>
                    <td className="num">{pct(p.modelProb)}</td>
                    <td className="num evtxt">+{(100 * p.ev).toFixed(1)}%</td>
                    <td className="num">{stake(p.kellyQuarter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="note" style={{ paddingLeft: 0 }}>
        Goal-based markets only — corners and cards trade on Cloudbet but the model has no corners/cards
        data, so it won&apos;t price them. Stakes are quarter-Kelly on your bankroll; edges are model
        estimates, not guarantees. Never bet more than you can afford to lose.
      </p>
    </div>
  );
}
