"use client";
import { useEffect, useMemo, useState } from "react";

type Pred = {
  home: string; away: string; xg: [number, number];
  p1: number; pX: number; p2: number; over25: number; btts: number;
  topScores: [string, number][];
};
type UpMatch = { date: string; home: string; away: string; neutral: boolean; pred: Pred };
type State = {
  trainedAt: number;
  coef: { a: number; b: number };
  ratings: { team: string; elo: number }[];
  upcoming: UpMatch[];
  tournament: { played: number; remaining: number };
};

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const fair = (p: number) => (p > 0 ? (1 / p).toFixed(2) : "—");

export default function Page() {
  const [tab, setTab] = useState<"board" | "match" | "sim" | "value" | "ratings">("board");
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const loadState = async (refresh = false) => {
    setLoading(true); setErr("");
    try {
      const r = await fetch(`/api/state${refresh ? "?refresh=1" : ""}`);
      if (!r.ok) throw new Error(await r.text());
      setState(await r.json());
    } catch (e: any) { setErr(e.message); }
    setLoading(false);
  };
  useEffect(() => { loadState(); }, []);

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>WC26 <span>Odds Desk</span></h1>
        <div className="meta">
          {state && (
            <>
              model a={state.coef.a.toFixed(4)} b={state.coef.b.toFixed(6)}<br />
              {state.tournament.played} played · {state.tournament.remaining} fixtures ·
              trained {new Date(state.trainedAt).toLocaleTimeString()}
            </>
          )}
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        {([["board", "Fixtures"], ["match", "Match"], ["sim", "Simulate"], ["value", "Value bets"], ["ratings", "Ratings"]] as const)
          .map(([k, label]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
          ))}
      </nav>

      {err && <div className="panel"><div className="err">{err}</div></div>}
      {loading && !state && <div className="panel"><div className="note">Training model on full international history…</div></div>}

      {state && tab === "board" && <Board state={state} onRefresh={() => loadState(true)} loading={loading} />}
      {tab === "match" && <MatchTab />}
      {tab === "sim" && <SimTab />}
      {tab === "value" && <ValueTab />}
      {state && tab === "ratings" && <Ratings state={state} />}

      <p className="note" style={{ paddingLeft: 0 }}>
        Model estimates only — edges are not guarantees. Stake sizes shown are quarter-Kelly caps; never bet more than you can afford to lose.
      </p>
    </div>
  );
}

function Board({ state, onRefresh, loading }: { state: State; onRefresh: () => void; loading: boolean }) {
  return (
    <section className="panel">
      <div className="head">
        Remaining fixtures — model 1X2 and fair odds
        <div className="right">
          <button className="btn ghost" onClick={onRefresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh data"}
          </button>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="board">
          <thead>
            <tr>
              <th>Date</th><th>Fixture</th>
              <th className="num">1</th><th className="num">X</th><th className="num">2</th>
              <th className="num">Fair 1/X/2</th><th className="num">xG</th><th className="num">O2.5</th>
            </tr>
          </thead>
          <tbody>
            {state.upcoming.map((m, i) => {
              const p = m.pred;
              const favHome = p.p1 >= p.p2;
              return (
                <tr key={i}>
                  <td>{m.date}</td>
                  <td>
                    <span className={`team ${favHome ? "fav" : ""}`}>{m.home}</span>
                    {" vs "}
                    <span className={`team ${!favHome ? "fav" : ""}`}>{m.away}</span>
                    {!m.neutral && <span className="pill" style={{ marginLeft: 8 }}>home adv</span>}
                  </td>
                  <td className="num">{pct(p.p1)}</td>
                  <td className="num">{pct(p.pX)}</td>
                  <td className="num">{pct(p.p2)}</td>
                  <td className="num">{fair(p.p1)} / {fair(p.pX)} / {fair(p.p2)}</td>
                  <td className="num">{p.xg[0]}–{p.xg[1]}</td>
                  <td className="num">{pct(p.over25)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MatchTab() {
  const [home, setHome] = useState("Brazil");
  const [away, setAway] = useState("Norway");
  const [neutral, setNeutral] = useState(true);
  const [res, setRes] = useState<{ pred: Pred; koWinProb: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const run = async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ home, away, neutral }),
      });
      if (!r.ok) throw new Error(await r.text());
      setRes(await r.json());
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <section className="panel">
      <div className="head">Price any match</div>
      <div className="controls">
        <label className="field">Home<input type="text" value={home} onChange={(e) => setHome(e.target.value)} /></label>
        <label className="field">Away<input type="text" value={away} onChange={(e) => setAway(e.target.value)} /></label>
        <label className="field">Venue
          <select value={neutral ? "n" : "h"} onChange={(e) => setNeutral(e.target.value === "n")}>
            <option value="n">Neutral</option>
            <option value="h">Home advantage</option>
          </select>
        </label>
        <button className="btn" onClick={run} disabled={busy}>{busy ? "Pricing…" : "Price match"}</button>
      </div>
      {err && <div className="err">{err}</div>}
      {res && (
        <div style={{ overflowX: "auto" }}>
          <table className="board">
            <thead>
              <tr><th>Market</th><th className="num">Probability</th><th className="num">Fair odds</th></tr>
            </thead>
            <tbody>
              <tr><td>{res.pred.home} win</td><td className="num">{pct(res.pred.p1)}</td><td className="num">{fair(res.pred.p1)}</td></tr>
              <tr><td>Draw</td><td className="num">{pct(res.pred.pX)}</td><td className="num">{fair(res.pred.pX)}</td></tr>
              <tr><td>{res.pred.away} win</td><td className="num">{pct(res.pred.p2)}</td><td className="num">{fair(res.pred.p2)}</td></tr>
              <tr><td>Over 2.5</td><td className="num">{pct(res.pred.over25)}</td><td className="num">{fair(res.pred.over25)}</td></tr>
              <tr><td>BTTS yes</td><td className="num">{pct(res.pred.btts)}</td><td className="num">{fair(res.pred.btts)}</td></tr>
              <tr><td>{res.pred.home} advance (KO)</td><td className="num">{pct(res.koWinProb)}</td><td className="num">{fair(res.koWinProb)}</td></tr>
              <tr>
                <td>Likely scores</td>
                <td className="num" colSpan={2}>
                  {res.pred.topScores.map(([s, p]) => `${s} (${pct(p)})`).join("  ·  ")}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SimTab() {
  const [nSims, setNSims] = useState(20000);
  const [res, setRes] = useState<{ win: [string, number][]; final: [string, number][] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const run = async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nSims }),
      });
      if (!r.ok) throw new Error(await r.text());
      setRes(await r.json());
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <>
      <section className="panel">
        <div className="head">Tournament simulation</div>
        <div className="controls">
          <label className="field">Simulations
            <input type="number" min={1000} max={100000} step={1000} value={nSims}
              onChange={(e) => setNSims(Number(e.target.value))} />
          </label>
          <button className="btn" onClick={run} disabled={busy}>{busy ? "Simulating…" : "Run simulation"}</button>
        </div>
        <div className="note">
          Bracket is seeded from the remaining fixtures; later rounds pair winners in fixture order.
          Verify against the official FIFA bracket before trusting outright prices.
        </div>
        {err && <div className="err">{err}</div>}
      </section>
      {res && (
        <div className="grid2" style={{ marginTop: 16 }}>
          <section className="panel">
            <div className="head">Win tournament</div>
            <table className="board">
              <thead><tr><th>Team</th><th className="num">P</th><th className="num">Fair odds</th></tr></thead>
              <tbody>
                {res.win.map(([t, p]) => (
                  <tr key={t}><td className="team">{t}</td><td className="num">{pct(p)}</td><td className="num">{fair(p)}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel">
            <div className="head">Reach final</div>
            <table className="board">
              <thead><tr><th>Team</th><th className="num">P</th></tr></thead>
              <tbody>
                {res.final.slice(0, 12).map(([t, p]) => (
                  <tr key={t}><td className="team">{t}</td><td className="num">{pct(p)}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </>
  );
}

function ValueTab() {
  const [minEdge, setMinEdge] = useState(0.03);
  const [picks, setPicks] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const run = async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`/api/value?minEdge=${minEdge}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "request failed");
      setPicks(j.picks);
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

  const maxEv = useMemo(() => Math.max(0.001, ...(picks ?? []).map((p) => p.ev)), [picks]);

  return (
    <section className="panel">
      <div className="head">Model vs Cloudbet — value board</div>
      <div className="controls">
        <label className="field">Min edge (EV)
          <input type="number" step={0.01} min={0} max={0.5} value={minEdge}
            onChange={(e) => setMinEdge(Number(e.target.value))} />
        </label>
        <button className="btn" onClick={run} disabled={busy}>{busy ? "Scanning…" : "Scan markets"}</button>
      </div>
      {err && <div className="err">{err}{err.includes("CLOUDBET_API_KEY") && " — add it in Vercel → Settings → Environment Variables."}</div>}
      {picks && picks.length === 0 && <div className="note">No selections above the edge threshold right now.</div>}
      {picks && picks.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="board">
            <thead>
              <tr>
                <th>Match</th><th>Bet</th>
                <th className="num">Odds</th><th className="num">Model</th><th className="num">Implied</th>
                <th>Edge</th><th className="num">Stake ¼K</th>
              </tr>
            </thead>
            <tbody>
              {picks.map((p, i) => (
                <tr key={i}>
                  <td className="team">{p.match}</td>
                  <td style={{ textTransform: "uppercase" }}>{p.bet}</td>
                  <td className="num">{p.odds.toFixed(2)}</td>
                  <td className="num">{pct(p.modelProb)}</td>
                  <td className="num">{pct(p.impliedProb)}</td>
                  <td className="evcell">
                    <span className="evbar" style={{ width: `${(p.ev / maxEv) * 100}%` }} />
                    <span className="evtxt">+{(100 * p.ev).toFixed(1)}%</span>
                  </td>
                  <td className="num">{pct(p.kellyQuarter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Ratings({ state }: { state: State }) {
  return (
    <section className="panel">
      <div className="head">Elo ratings — top 30</div>
      <table className="board">
        <thead><tr><th>#</th><th>Team</th><th className="num">Elo</th></tr></thead>
        <tbody>
          {state.ratings.map((r, i) => (
            <tr key={r.team}>
              <td>{i + 1}</td>
              <td className={`team ${i < 3 ? "fav" : ""}`}>{r.team}</td>
              <td className="num">{r.elo.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
