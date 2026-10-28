import { createServerFn } from "@tanstack/react-start";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-3.1-pro-preview";
const CURRENT_DATE = "July 2026";
const DATE_CONTEXT = `IMPORTANT: Today is ${CURRENT_DATE}. All stats, titles, rankings, records, transfers and achievements MUST reflect the state of the sport as of ${CURRENT_DATE}. Use verified real-world results through the 2025 season and the first half of 2026 (examples: IPL 2025 winner was Royal Challengers Bengaluru — their first-ever IPL title; IPL 2024 winner was Kolkata Knight Riders; 2025 F1 champion was Lando Norris; 2025 Wimbledon men's champion was Jannik Sinner, women's was Iga Swiatek; 2024 T20 World Cup winner was India). ACCURACY RULES: (1) Never fabricate winners, scores, records, or player stats. (2) If you don't know a specific fact with high confidence, either omit it or state it in general terms — do NOT invent a plausible-sounding number or name. (3) Prefer widely reported public facts over precise unverifiable figures. (4) It is better to return fewer, correct data points than many wrong ones.`;

type EntityInput = {
  kind: "team" | "player";
  name: string;
  sport: string;
  team?: string;
  nationality?: string;
  description?: string;
};

async function callGateway(system: string, user: string): Promise<string> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("Missing LOVABLE_API_KEY");

  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.15,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) throw new Error("AI is rate-limited. Try again shortly.");
    if (res.status === 402) throw new Error("AI credits exhausted. Add credits in workspace settings.");
    throw new Error(`AI request failed [${res.status}]: ${body}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content ?? "{}";
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    // Strip code fences if any
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
}

export type AiAnalysis = {
  summary: string;
  strengths: string[];
  weaknesses: string[];
};

export const analyzeEntity = createServerFn({ method: "POST" })
  .inputValidator((input: EntityInput) => {
    if (!input || typeof input.name !== "string" || !input.name.trim()) {
      throw new Error("name is required");
    }
    return {
      kind: input.kind === "team" ? "team" : "player",
      name: input.name.slice(0, 120),
      sport: (input.sport ?? "").slice(0, 40),
      team: input.team?.slice(0, 120),
      nationality: input.nationality?.slice(0, 80),
      description: input.description?.slice(0, 4000),
    } as EntityInput;
  })
  .handler(async ({ data }) => {
    const system = `You are a sports analyst. Return concise, factual analysis as JSON only.
${DATE_CONTEXT}
Schema: { "summary": string (2-3 sentences), "strengths": string[] (3-5 short bullets), "weaknesses": string[] (2-4 short bullets) }.
Base analysis on well-known public information current as of ${CURRENT_DATE}. If unsure about a specific claim, keep it general. No preamble, JSON only.`;

    const user = `Analyze this ${data.kind} in ${data.sport}:
Name: ${data.name}
${data.team ? `Team: ${data.team}\n` : ""}${data.nationality ? `Nationality: ${data.nationality}\n` : ""}${data.description ? `Bio: ${data.description}\n` : ""}
Give: summary, strengths, weaknesses.`;

    const raw = await callGateway(system, user);
    const parsed = safeJson<AiAnalysis>(raw, {
      summary: "",
      strengths: [],
      weaknesses: [],
    });
    return {
      summary: String(parsed.summary ?? ""),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 6).map(String) : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.slice(0, 6).map(String) : [],
    };
  });

export type Comparison = {
  verdict: string;
  categories: { label: string; a: string; b: string; edge: "a" | "b" | "even" }[];
  aEdge: string[];
  bEdge: string[];
};

type ComparePair = {
  sport: string;
  a: EntityInput;
  b: EntityInput;
};

export const compareEntities = createServerFn({ method: "POST" })
  .inputValidator((input: ComparePair) => {
    if (!input?.a?.name || !input?.b?.name) throw new Error("Two entities required");
    return input;
  })
  .handler(async ({ data }) => {
    const system = `You are a sports analyst. Compare two ${data.sport} entities objectively.
${DATE_CONTEXT}
Return JSON only, no preamble.
Schema: {
  "verdict": string (2-3 sentence overall summary as of ${CURRENT_DATE}),
  "categories": [{ "label": string, "a": string, "b": string, "edge": "a"|"b"|"even" }] (4-6 rows across relevant axes like Peak performance, Consistency, Big-match record, Longevity, Style; cell values should reference up-to-date stats through ${CURRENT_DATE}),
  "aEdge": string[] (2-4 areas where A is stronger),
  "bEdge": string[] (2-4 areas where B is stronger)
}`;

    const fmt = (e: EntityInput) =>
      `${e.name} (${e.kind}${e.team ? `, ${e.team}` : ""}${e.nationality ? `, ${e.nationality}` : ""})${e.description ? `\nBio: ${e.description.slice(0, 1500)}` : ""}`;

    const user = `Compare in ${data.sport}:

A: ${fmt(data.a)}

B: ${fmt(data.b)}`;

    const raw = await callGateway(system, user);
    const parsed = safeJson<Comparison>(raw, {
      verdict: "",
      categories: [],
      aEdge: [],
      bEdge: [],
    });
    return {
      verdict: String(parsed.verdict ?? ""),
      categories: Array.isArray(parsed.categories)
        ? parsed.categories.slice(0, 8).map((c) => ({
            label: String(c.label ?? ""),
            a: String(c.a ?? ""),
            b: String(c.b ?? ""),
            edge: c.edge === "a" || c.edge === "b" ? c.edge : "even",
          }))
        : [],
      aEdge: Array.isArray(parsed.aEdge) ? parsed.aEdge.slice(0, 6).map(String) : [],
      bEdge: Array.isArray(parsed.bEdge) ? parsed.bEdge.slice(0, 6).map(String) : [],
    };
  });

export type StatSeries = {
  key: string;
  label: string;
  unit?: string;
  description?: string;
  series: { year: number; value: number }[];
};
export type EntityStats = {
  notes: string;
  metrics: StatSeries[];
};

export const entityStats = createServerFn({ method: "POST" })
  .inputValidator((input: EntityInput) => {
    if (!input?.name) throw new Error("name required");
    return input;
  })
  .handler(async ({ data }) => {
    const sport = data.sport;
    const metricHint =
      sport === "Tennis"
        ? "forehand quality, backhand quality, serve rating, return rating, movement, mental strength"
        : sport === "Cricket"
          ? "batting average, strike rate, bowling economy, fielding rating, form index"
          : sport === "Motorsport" || sport === "F1"
            ? "qualifying pace, race pace, tyre management, wet-weather skill, consistency"
            : sport === "Football" || sport === "Soccer"
              ? "goals per season, assists per season, shot accuracy, passing accuracy, dribbling, defensive contribution, overall rating"
              : "overall rating, form, consistency";

    const system = `You are a sports analyst producing year-by-year performance ratings.
${DATE_CONTEXT}
Return JSON only. Ratings are estimates on a 0-100 scale unless a natural unit exists (e.g. cricket batting average).
For a ${data.kind}, produce 4-6 metrics covering: ${metricHint}.
Each metric MUST include a "series" with one point per year covering the entity's meaningful career window and ending at 2026.
For active athletes with short careers, start at their debut year. For teams, span the last ~10-15 years.
Schema: {
  "notes": string (1 sentence caveat that these are AI-estimated indices),
  "metrics": [{
    "key": string (short id),
    "label": string (human label, e.g. "Forehand quality"),
    "unit": string (e.g. "/100" or "avg"),
    "description": string (1 short sentence),
    "series": [{ "year": number, "value": number }]
  }]
}
Values should reflect realistic trajectories (peaks, dips, injuries) as of ${CURRENT_DATE}. No preamble.`;

    const user = `Entity: ${data.name}
Kind: ${data.kind}
Sport: ${sport}
${data.team ? `Team: ${data.team}\n` : ""}${data.nationality ? `Nationality: ${data.nationality}\n` : ""}${data.description ? `Bio: ${data.description.slice(0, 1200)}\n` : ""}
Produce year-by-year metric series through 2026.`;

    const raw = await callGateway(system, user);
    const parsed = safeJson<EntityStats>(raw, { notes: "", metrics: [] });
    return {
      notes: String(parsed.notes ?? ""),
      metrics: Array.isArray(parsed.metrics)
        ? parsed.metrics.slice(0, 8).map((m) => ({
            key: String(m.key ?? m.label ?? "metric"),
            label: String(m.label ?? m.key ?? "Metric"),
            unit: m.unit ? String(m.unit) : undefined,
            description: m.description ? String(m.description) : undefined,
            series: Array.isArray(m.series)
              ? m.series
                  .map((p) => ({
                    year: Number(p.year),
                    value: Number(p.value),
                  }))
                  .filter((p) => Number.isFinite(p.year) && Number.isFinite(p.value))
                  .sort((a, b) => a.year - b.year)
              : [],
          }))
        : [],
    };
  });

export type MajorWin = {
  title: string;
  year: string;
  detail?: string;
  tier?: "legendary" | "major" | "notable";
};
export type MajorWins = {
  category: string;
  wins: MajorWin[];
  notes?: string;
};

export const majorWins = createServerFn({ method: "POST" })
  .inputValidator((input: EntityInput) => {
    if (!input?.name) throw new Error("name required");
    return input;
  })
  .handler(async ({ data }) => {
    const sport = data.sport;
    const categoryHint =
      sport === "Tennis"
        ? "Grand Slam singles titles (Australian Open, Roland Garros, Wimbledon, US Open), then ATP/WTA Finals, Olympic gold, Masters 1000s"
        : sport === "Cricket"
          ? "ICC trophies (World Cup, T20 World Cup, Champions Trophy), major series wins, IPL titles, individual milestones (double centuries, 5-fers in finals)"
          : sport === "Motorsport" || sport === "F1"
            ? "F1 World Drivers' Championships, then iconic race wins (Monaco GP, British GP, Italian GP), pole records, constructor titles for teams"
            : sport === "Football" || sport === "Soccer"
              ? "FIFA World Cup, UEFA Champions League, continental titles (Euros, Copa America, AFCON), major domestic league titles (Premier League, La Liga, Serie A, Bundesliga), Ballon d'Or (players), domestic cups"
              : "the most prestigious trophies and championships of the sport";

    const system = `You are a sports historian. Return the MOST RECOGNIZABLE, career-defining wins for a ${data.kind} in ${sport}, as JSON only.
${DATE_CONTEXT}
Prioritize ${categoryHint}. Order from most recent to oldest. Include ONLY wins you are confident are real (verifiable public record through ${CURRENT_DATE}). If the athlete has none of these, return an empty wins array — do NOT invent titles.
Schema: {
  "category": string (e.g. "Grand Slam titles", "ICC & IPL trophies", "F1 championships & iconic wins"),
  "wins": [{
    "title": string (e.g. "Wimbledon", "IPL", "Monaco Grand Prix"),
    "year": string (e.g. "2025" or "2023-24"),
    "detail": string (1 short clause: opponent beaten in final / team / margin — omit if unsure),
    "tier": "legendary" | "major" | "notable"
  }] (up to 20, most recent first),
  "notes": string (optional 1-sentence caveat)
}`;

    const user = `${data.kind}: ${data.name}
Sport: ${sport}
${data.team ? `Team: ${data.team}\n` : ""}${data.nationality ? `Nationality: ${data.nationality}\n` : ""}List their most recognizable, career-defining wins as of ${CURRENT_DATE}.`;

    const raw = await callGateway(system, user);
    const parsed = safeJson<MajorWins>(raw, { category: "", wins: [] });
    return {
      category: String(parsed.category ?? ""),
      wins: Array.isArray(parsed.wins)
        ? parsed.wins.slice(0, 24).map((w) => ({
            title: String(w.title ?? ""),
            year: String(w.year ?? ""),
            detail: w.detail ? String(w.detail) : undefined,
            tier: (w.tier === "legendary" || w.tier === "notable" ? w.tier : "major") as MajorWin["tier"],
          }))
        : [],
      notes: parsed.notes ? String(parsed.notes) : undefined,
      source: "ai" as const,
    };
  });

export type EventStat = { label: string; value: string };
export type EventPerformer = { name: string; role?: string; stat: string };
export type EventChart = {
  key: string;
  label: string;
  unit?: string;
  description?: string;
  series: { label: string; value: number }[];
};
export type EventAnalysis = {
  title: string;
  dateRange: string;
  venue?: string;
  overview: string;
  winner?: string;
  runnersUp?: string[];
  keyStats: EventStat[];
  topPerformers: EventPerformer[];
  highlights: string[];
  charts: EventChart[];
  notes?: string;
};

type EventInput = { sport: string; name: string };

export const analyzeEvent = createServerFn({ method: "POST" })
  .inputValidator((input: EventInput) => {
    if (!input?.name?.trim()) throw new Error("event name required");
    return {
      sport: (input.sport ?? "").slice(0, 40),
      name: input.name.slice(0, 160).trim(),
    };
  })
  .handler(async ({ data }) => {
    const chartHint =
      data.sport === "Tennis"
        ? 'e.g. aces per top-4 player, sets dropped by champion, first-serve % of finalists'
        : data.sport === "Cricket"
          ? 'e.g. top run-scorers, top wicket-takers, team net run rates'
          : data.sport === "F1" || data.sport === "Motorsport"
            ? 'e.g. lap times of top drivers, points scored by top drivers, fastest sector splits'
            : data.sport === "Football" || data.sport === "Soccer"
              ? 'e.g. top scorers, top assisters, team goals scored, xG leaders'
              : 'top performers vs key metric';

    const system = `You are a sports analyst producing a factual event dossier as JSON only.
${DATE_CONTEXT}
Return concise, accurate stats for a specific sporting event. Prefer well-known public info; if a figure is uncertain, keep it general (avoid inventing exact numbers).
Schema: {
  "title": string (canonical event title),
  "dateRange": string (e.g. "27 May – 9 Jun 2024"),
  "venue": string,
  "overview": string (2-3 sentence recap),
  "winner": string,
  "runnersUp": string[] (0-3),
  "keyStats": [{ "label": string, "value": string }] (4-8 rows: match count, prize money, records, attendance, etc),
  "topPerformers": [{ "name": string, "role": string, "stat": string }] (3-6 rows),
  "highlights": string[] (3-6 short bullets of notable moments),
  "charts": [{
    "key": string,
    "label": string,
    "unit": string,
    "description": string,
    "series": [{ "label": string, "value": number }]
  }] (2-3 chart-friendly bar series, ${chartHint}),
  "notes": string (1 sentence caveat)
}`;

    const user = `Sport: ${data.sport}
Event: ${data.name}
Produce the event dossier. If the exact edition is ambiguous, cover the most recent completed edition as of ${CURRENT_DATE}.`;

    const raw = await callGateway(system, user);
    const parsed = safeJson<EventAnalysis>(raw, {
      title: data.name,
      dateRange: "",
      overview: "",
      keyStats: [],
      topPerformers: [],
      highlights: [],
      charts: [],
    });
    return {
      title: String(parsed.title ?? data.name),
      dateRange: String(parsed.dateRange ?? ""),
      venue: parsed.venue ? String(parsed.venue) : undefined,
      overview: String(parsed.overview ?? ""),
      winner: parsed.winner ? String(parsed.winner) : undefined,
      runnersUp: Array.isArray(parsed.runnersUp) ? parsed.runnersUp.slice(0, 4).map(String) : [],
      keyStats: Array.isArray(parsed.keyStats)
        ? parsed.keyStats.slice(0, 10).map((s) => ({ label: String(s.label ?? ""), value: String(s.value ?? "") }))
        : [],
      topPerformers: Array.isArray(parsed.topPerformers)
        ? parsed.topPerformers.slice(0, 8).map((p) => ({
            name: String(p.name ?? ""),
            role: p.role ? String(p.role) : undefined,
            stat: String(p.stat ?? ""),
          }))
        : [],
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.slice(0, 8).map(String) : [],
      charts: Array.isArray(parsed.charts)
        ? parsed.charts.slice(0, 4).map((c) => ({
            key: String(c.key ?? c.label ?? "chart"),
            label: String(c.label ?? "Chart"),
            unit: c.unit ? String(c.unit) : undefined,
            description: c.description ? String(c.description) : undefined,
            series: Array.isArray(c.series)
              ? c.series
                  .map((p) => ({ label: String(p.label ?? ""), value: Number(p.value) }))
                  .filter((p) => p.label && Number.isFinite(p.value))
              : [],
          }))
        : [],
      notes: parsed.notes ? String(parsed.notes) : undefined,
    };
  });

export type LiveInsight = {
  recap: string;
  excitement: string;
  prediction: string;
  keyMoments: string[];
};

type LiveInsightInput = {
  sport: string;
  league?: string;
  state: string; // "in" | "pre" | "post"
  status?: string;
  detail?: string;
  home: { name: string; score?: string };
  away: { name: string; score?: string };
  note?: string;
};

export const liveInsight = createServerFn({ method: "POST" })
  .inputValidator((input: LiveInsightInput) => {
    if (!input?.home?.name || !input?.away?.name) throw new Error("teams required");
    return input;
  })
  .handler(async ({ data }) => {
    const phase =
      data.state === "in"
        ? "in-progress"
        : data.state === "pre"
          ? "upcoming (not started)"
          : "finished";

    const system = `You are a live sports analyst. Return JSON only.
${DATE_CONTEXT}
Given a ${data.sport} match that is ${phase}, produce:
Schema: {
  "recap": string (2-3 sentences summarizing what has happened so far based on the current score/state; if upcoming, describe stakes, form, and context instead),
  "excitement": string (1-2 sentences on why this match is exciting — rivalry, stakes, records on the line, storylines),
  "prediction": string (1-2 sentences with a grounded prediction of the likely outcome or key thing to watch; if finished, describe the decisive moment and what it means),
  "keyMoments": string[] (2-4 short bullets of notable turning points, records, or storylines relevant to this match)
}
Base statements on plausible, well-known context. If the score is available, ground the recap in it. Do NOT invent specific unverifiable numbers. Keep it concise.`;

    const user = `Sport: ${data.sport}
${data.league ? `League: ${data.league}\n` : ""}Phase: ${phase}
Status: ${data.status ?? ""}${data.detail ? ` (${data.detail})` : ""}
${data.home.name} ${data.home.score ?? "-"}  vs  ${data.away.name} ${data.away.score ?? "-"}
${data.note ? `Note: ${data.note}\n` : ""}
Produce the live insight JSON.`;

    const raw = await callGateway(system, user);
    const parsed = safeJson<LiveInsight>(raw, {
      recap: "",
      excitement: "",
      prediction: "",
      keyMoments: [],
    });
    return {
      recap: String(parsed.recap ?? ""),
      excitement: String(parsed.excitement ?? ""),
      prediction: String(parsed.prediction ?? ""),
      keyMoments: Array.isArray(parsed.keyMoments)
        ? parsed.keyMoments.slice(0, 6).map(String)
        : [],
    };
  });

export type F1Driver = {
  position: number;
  driver: string;
  team: string;
  gap: string;      // "Leader", "+2.145", "+1 Lap"
  lastLap?: string; // "1:19.842"
  tire?: string;    // "Soft" | "Medium" | "Hard" | "Inter" | "Wet"
  tireAge?: number; // laps on current set
  status?: string;  // "Running", "Pit", "DNF", "Retired"
  change?: number;  // positions gained/lost vs start (positive = gained)
};

export type F1LiveGrid = {
  race: string;
  session: string; // "Race lap 34/57" | "Qualifying Q3" | "Between sessions"
  phase: "in" | "pre" | "post";
  narrative: string;
  battles: string[];
  strategy: string;
  drivers: F1Driver[];
  disclaimer: string;
};

type F1GridInput = { event?: string; status?: string; detail?: string };

export const f1LiveGrid = createServerFn({ method: "POST" })
  .inputValidator((input: F1GridInput) => input ?? {})
  .handler(async ({ data }) => {
    const system = `You are an F1 live-timing analyst. Return JSON only.
${DATE_CONTEXT}
Produce a plausible live grid snapshot for the current or most recent F1 session as of ${CURRENT_DATE}.
CRITICAL: If no session is currently in progress, describe the most recent completed race and set phase to "post".
Use ONLY real 2025/2026 F1 drivers and teams (all 20 drivers on the current grid + reserve drivers if needed to fill). Do not invent fictional drivers.
Schema: {
  "race": string (e.g. "British Grand Prix 2026"),
  "session": string (e.g. "Race — Lap 34/52" or "Qualifying Q3" or "Post-race"),
  "phase": "in" | "pre" | "post",
  "narrative": string (2-3 sentences of what is happening RIGHT NOW in the session),
  "battles": string[] (2-4 short bullets describing on-track battles or storylines),
  "strategy": string (1-2 sentences on tire strategy / undercut / weather),
  "drivers": [{
    "position": number (1-20),
    "driver": string (full name, e.g. "Lando Norris"),
    "team": string (e.g. "McLaren"),
    "gap": string (P1 = "Leader"; others = "+SS.sss" or "+N Laps"; DNF = "DNF"),
    "lastLap": string (e.g. "1:19.842" or ""),
    "tire": "Soft" | "Medium" | "Hard" | "Inter" | "Wet",
    "tireAge": number (laps on current compound, 0-40),
    "status": "Running" | "Pit" | "DNF" | "Retired" | "Out lap",
    "change": number (positions gained (+) or lost (-) vs starting grid; 0 if unknown)
  }] (exactly 20 rows, sorted by position ascending),
  "disclaimer": string (1 sentence: "AI-estimated snapshot; not real-time telemetry.")
}`;

    const user = `Event context: ${data.event ?? "current or most recent F1 Grand Prix"}
Status: ${data.status ?? ""}${data.detail ? ` (${data.detail})` : ""}
Produce the live grid snapshot with all 20 drivers.`;

    const raw = await callGateway(system, user);
    const parsed = safeJson<F1LiveGrid>(raw, {
      race: "",
      session: "",
      phase: "post",
      narrative: "",
      battles: [],
      strategy: "",
      drivers: [],
      disclaimer: "",
    });
    return {
      race: String(parsed.race ?? ""),
      session: String(parsed.session ?? ""),
      phase: (parsed.phase === "in" || parsed.phase === "pre" ? parsed.phase : "post") as F1LiveGrid["phase"],
      narrative: String(parsed.narrative ?? ""),
      battles: Array.isArray(parsed.battles) ? parsed.battles.slice(0, 6).map(String) : [],
      strategy: String(parsed.strategy ?? ""),
      drivers: Array.isArray(parsed.drivers)
        ? parsed.drivers.slice(0, 22).map((d, i) => ({
            position: Number.isFinite(Number(d.position)) ? Number(d.position) : i + 1,
            driver: String(d.driver ?? ""),
            team: String(d.team ?? ""),
            gap: String(d.gap ?? ""),
            lastLap: d.lastLap ? String(d.lastLap) : undefined,
            tire: d.tire ? String(d.tire) : undefined,
            tireAge: Number.isFinite(Number(d.tireAge)) ? Number(d.tireAge) : undefined,
            status: d.status ? String(d.status) : "Running",
            change: Number.isFinite(Number(d.change)) ? Number(d.change) : 0,
          })).sort((a, b) => a.position - b.position)
        : [],
      disclaimer: String(parsed.disclaimer ?? "AI-estimated snapshot; not real-time telemetry."),
    };
  });

// ---------- Deep sport-specific stats & standings ----------

export type DeepStatsChart = {
  kind: "bar" | "radar";
  label: string;
  unit?: string;
  series: { label: string; value: number }[];
};
export type StatTable = {
  title: string;
  description?: string;
  columns: string[];
  rows: (string | number)[][];
  chart?: DeepStatsChart;
};
export type DeepStats = {
  headline: string;
  sections: StatTable[];
  notes?: string;
};

export const deepStats = createServerFn({ method: "POST" })
  .inputValidator((input: EntityInput) => {
    if (!input?.name) throw new Error("name required");
    return input;
  })
  .handler(async ({ data }) => {
    const sport = data.sport;
    const sectionHint =
      sport === "Cricket"
        ? `For a player: (1) Batting stats table (columns: Format, Mat, Runs, Avg, SR, 100s, 50s) across Test/ODI/T20I/IPL. (2) Bowling stats table (columns: Format, Mat, Wkts, Avg, Econ, SR, Best) if bowler. (3) Wagon-wheel shot distribution (bar chart % by region: Cover, Point, Third-man, Fine-leg, Square-leg, Mid-wicket, Mid-on, Straight). (4) Current ICC rankings (Batting / Bowling / All-rounder — Test / ODI / T20I). Omit sections that don't apply.
For a team: (1) Recent series record. (2) Format-wise win% (Test/ODI/T20I). (3) Top run-scorers & wicket-takers table.`
        : sport === "Tennis"
          ? `For a player: (1) Serve stats table (columns: Metric, Value, Tour avg — 1st serve %, 1st serve pts won %, 2nd serve pts won %, Aces/match, Double faults/match, Break pts saved %). (2) Return stats table (columns: Metric, Value — 1st serve return won %, 2nd serve return won %, Break pts converted %, Return games won %). (3) Surface record (columns: Surface, Matches, Win %, Titles) — Hard, Clay, Grass, Indoor. (4) Head-to-head vs top rivals (columns: Opponent, W, L, Last meeting).`
          : sport === "F1" || sport === "Motorsport"
            ? `For a driver: (1) 2026 season summary (columns: Metric, Value — Points, Wins, Podiums, Poles, Fastest laps, DNFs, Avg finish, Avg qual). (2) Qualifying pace vs teammate (bar chart: Δs per race weekend, positive = faster than teammate — cover current season race weekends). (3) Career championships & wins (columns: Season, Team, Wins, Podiums, Poles, Points, Championship). (4) Pit-stop average (columns: Season, Team, Avg pit-stop time (s), Fastest pit-stop). For a team: (1) Constructors' standings history. (2) Reliability (DNF %). (3) Pit-stop rankings.`
            : sport === "Football" || sport === "Soccer"
              ? `For a player: (1) Season stats table (columns: Season, Club, Comp, Apps, Goals, Assists, xG, xA, Mins). (2) Discipline (Yellow, Red, Fouls/90). (3) Shooting profile (bar chart: Shot conversion %, Big chances scored %, Shots/90, xG overperformance). (4) League ranking metrics (Goals rank in league, Assists rank).
For a team: (1) League table position (columns: Season, League, Pos, P, W, D, L, GF, GA, GD, Pts, xG). (2) Top scorers this season. (3) xG/xGA (bar chart per recent matches).`
              : `Produce 2-3 highly relevant stat tables + one chart for this sport.`;

    const system = `You are a sports analyst producing detailed sport-specific stat tables. Return JSON only.
${DATE_CONTEXT}
Rules:
- Only include sections that apply to this ${data.kind} in ${sport}. If a stat doesn't apply (e.g. bowling stats for a pure batter), omit that section.
- Every row must have the same number of cells as columns. Numeric where natural, strings where categorical.
- Prefer widely reported public figures. If uncertain, keep the row out — do not invent numbers.
Schema: {
  "headline": string (1 sentence framing),
  "sections": [{
    "title": string,
    "description": string,
    "columns": string[] (2-8),
    "rows": (string|number)[][] (up to 12 rows, each length = columns.length),
    "chart": { "kind": "bar"|"radar", "label": string, "unit": string, "series": [{"label": string, "value": number}] } (optional; include for wagon-wheel / qualifying pace / xG profile / shooting profile)
  }] (2-4 sections),
  "notes": string (optional caveat)
}
Section hint for this sport: ${sectionHint}`;

    const user = `${data.kind}: ${data.name}
Sport: ${sport}
${data.team ? `Team: ${data.team}\n` : ""}${data.nationality ? `Nationality: ${data.nationality}\n` : ""}${data.description ? `Bio: ${data.description.slice(0, 1000)}\n` : ""}
Produce the deep stats JSON as of ${CURRENT_DATE}.`;

    const raw = await callGateway(system, user);
    const parsed = safeJson<DeepStats>(raw, { headline: "", sections: [] });
    const sections = Array.isArray(parsed.sections)
      ? parsed.sections
          .slice(0, 6)
          .map((s) => {
            const columns = Array.isArray(s.columns) ? s.columns.slice(0, 10).map(String) : [];
            const rows = Array.isArray(s.rows)
              ? s.rows
                  .slice(0, 20)
                  .map((r) =>
                    Array.isArray(r)
                      ? r.slice(0, columns.length).map((c) => (typeof c === "number" ? c : String(c ?? "")))
                      : [],
                  )
                  .filter((r) => r.length === columns.length && columns.length > 0)
              : [];
            const chart = s.chart && Array.isArray(s.chart.series)
              ? {
                  kind: (s.chart.kind === "radar" ? "radar" : "bar") as "bar" | "radar",
                  label: String(s.chart.label ?? ""),
                  unit: s.chart.unit ? String(s.chart.unit) : undefined,
                  series: s.chart.series
                    .map((p) => ({ label: String(p.label ?? ""), value: Number(p.value) }))
                    .filter((p) => p.label && Number.isFinite(p.value))
                    .slice(0, 20),
                }
              : undefined;
            return {
              title: String(s.title ?? ""),
              description: s.description ? String(s.description) : undefined,
              columns,
              rows,
              chart,
            };
          })
          .filter((s) => s.columns.length > 0 && s.rows.length > 0)
      : [];
    return {
      headline: String(parsed.headline ?? ""),
      sections,
      notes: parsed.notes ? String(parsed.notes) : undefined,
    };
  });

export type StandingsRow = {
  rank: number;
  name: string;
  cells: (string | number)[];
  change?: number; // +/- position change vs previous
};
export type Standings = {
  title: string;
  subtitle?: string;
  columns: string[]; // labels for cells (excluding rank+name)
  rows: StandingsRow[];
  notes?: string;
  source?: "espn" | "ai";
};

type StandingsInput = { sport: string; league: string };

export const standings = createServerFn({ method: "POST" })
  .inputValidator((input: StandingsInput) => {
    if (!input?.league?.trim()) throw new Error("league required");
    return {
      sport: (input.sport ?? "").slice(0, 40),
      league: input.league.slice(0, 120).trim(),
    };
  })
  .handler(async ({ data }): Promise<Standings> => {
    const real = await espnStandings(data.sport, data.league);
    if (real) return real;
    const columnsHint =
      data.sport === "Cricket"
        ? `Points table columns: P, W, L, T/NR, NRR, Pts (or for Test league: Matches, Series won, PCT, Rating)`
        : data.sport === "Tennis"
          ? `Rankings columns: Points, Tournaments played, Prev rank`
          : data.sport === "F1" || data.sport === "Motorsport"
            ? `Drivers' standings columns: Team, Points, Wins, Podiums, Poles, DNFs. For constructors: Points, Wins, 1-2s, DNFs.`
            : data.sport === "Football" || data.sport === "Soccer"
              ? `League table columns: P, W, D, L, GF, GA, GD, Pts, Form (last 5)`
              : `Points and record columns`;

    const system = `You are a sports data provider. Return a standings table as JSON only.
${DATE_CONTEXT}
Return the MOST RECENT completed or in-progress standings for the requested league as of ${CURRENT_DATE}.
Do NOT invent fictional teams/players — only real ones known to exist in that league. Include top 10-20 entries.
${columnsHint}
Schema: {
  "title": string (canonical league name + season),
  "subtitle": string (e.g. "As of July 2026" or "Final standings 2025"),
  "columns": string[] (labels for each cell column, NOT including rank/name),
  "rows": [{
    "rank": number,
    "name": string (team or driver + team),
    "cells": (string|number)[] (same length as columns),
    "change": number (positions moved vs previous update, 0 if unknown)
  }] (up to 20, ordered by rank),
  "notes": string (optional 1-sentence caveat)
}`;

    const user = `Sport: ${data.sport}
League/Competition: ${data.league}
Return the current standings table.`;

    const raw = await callGateway(system, user);
    const parsed = safeJson<Standings>(raw, {
      title: data.league,
      columns: [],
      rows: [],
    });
    const columns = Array.isArray(parsed.columns) ? parsed.columns.slice(0, 12).map(String) : [];
    return {
      title: String(parsed.title ?? data.league),
      subtitle: parsed.subtitle ? String(parsed.subtitle) : undefined,
      columns,
      rows: Array.isArray(parsed.rows)
        ? parsed.rows
            .slice(0, 24)
            .map((r, i) => ({
              rank: Number.isFinite(Number(r.rank)) ? Number(r.rank) : i + 1,
              name: String(r.name ?? ""),
              cells: Array.isArray(r.cells)
                ? r.cells.slice(0, columns.length).map((c) => (typeof c === "number" ? c : String(c ?? "")))
                : [],
              change: Number.isFinite(Number(r.change)) ? Number(r.change) : 0,
            }))
            .filter((r) => r.name)
        : [],
      notes: parsed.notes ? String(parsed.notes) : undefined,
    };
  });

// ---------- Real standings from ESPN (where available) ----------
function espnLeaguePath(sport: string, league: string): string | null {
  const l = league.toLowerCase();
  if (sport === "Football" || sport === "Soccer") {
    if (l.includes("premier")) return "soccer/eng.1";
    if (l.includes("la liga") || l.includes("laliga")) return "soccer/esp.1";
    if (l.includes("serie a")) return "soccer/ita.1";
    if (l.includes("bundesliga")) return "soccer/ger.1";
    if (l.includes("ligue 1")) return "soccer/fra.1";
    if (l.includes("champions league")) return "soccer/uefa.champions";
    if (l.includes("mls")) return "soccer/usa.1";
    if (l.includes("eredivisie")) return "soccer/ned.1";
    return null;
  }
  if (sport === "F1" || sport === "Motorsport") {
    if (l.includes("f1") || l.includes("formula")) return "racing/f1";
  }
  return null;
}

type EspnStat = { name?: string; abbreviation?: string; displayValue?: string };
type EspnEntry = {
  team?: { displayName?: string; name?: string };
  athlete?: { displayName?: string };
  stats?: EspnStat[];
};

async function espnStandings(sport: string, league: string): Promise<Standings | null> {
  const path = espnLeaguePath(sport, league);
  if (!path) return null;
  try {
    const yearMatch = league.match(/\b(19|20)\d{2}\b/);
    const season = yearMatch ? yearMatch[0] : null;
    const res = await fetch(
      `https://site.api.espn.com/apis/v2/sports/${path}/standings${season ? `?season=${season}` : ""}`,
    );
    if (!res.ok) return null;
    const d = (await res.json()) as {
      name?: string;
      children?: { name?: string; standings?: { seasonDisplayName?: string; entries?: EspnEntry[] } }[];
    };
    const children = d.children ?? [];
    if (!children.length) return null;
    const stat = (e: EspnEntry, n: string) => e.stats?.find((s) => s.name === n)?.displayValue ?? "";
    if (path === "racing/f1") {
      const wantConstructors = league.toLowerCase().includes("constructor");
      const child =
        children.find((c) => (c.name ?? "").toLowerCase().includes(wantConstructors ? "constructor" : "driver")) ??
        children[0];
      const entries = child.standings?.entries ?? [];
      if (!entries.length) return null;
      const rows = entries.map((e, i) => ({
        rank: Number(stat(e, "rank")) || i + 1,
        name: e.athlete?.displayName ?? e.team?.displayName ?? "",
        cells: [stat(e, "championshipPts")],
        change: 0,
      }));
      rows.sort((a, b) => a.rank - b.rank);
      return {
        title: `F1 ${child.name ?? "Standings"}${season ? ` ${season}` : ""}`,
        subtitle: `${season ? `${season} season` : "Current season"} · live from ESPN`,
        columns: ["Pts"],
        rows: rows.filter((r) => r.name).slice(0, 24),
        source: "espn",
      };
    }
    // Football: may have multiple groups; flatten if one, otherwise use first table
    const child = children[0];
    const entries = child.standings?.entries ?? [];
    if (!entries.length) return null;
    const cols: [string, string][] = [
      ["P", "gamesPlayed"], ["W", "wins"], ["D", "ties"], ["L", "losses"],
      ["GF", "pointsFor"], ["GA", "pointsAgainst"], ["GD", "pointDifferential"], ["Pts", "points"],
    ];
    const rows = entries
      .map((e, i) => ({
        rank: Number(stat(e, "rank")) || i + 1,
        name: e.team?.displayName ?? e.team?.name ?? "",
        cells: cols.map(([, n]) => {
          const v = stat(e, n);
          const num = Number(v);
          return v !== "" && Number.isFinite(num) && !v.startsWith("+") ? num : v;
        }),
        change: Number(stat(e, "rankChange")) || 0,
      }))
      .sort((a, b) => a.rank - b.rank);
    return {
      title: child.name ?? d.name ?? league,
      subtitle: `${child.standings?.seasonDisplayName ?? "Current season"} · live from ESPN`,
      columns: cols.map(([l]) => l),
      rows: rows.filter((r) => r.name).slice(0, 36),
      source: "espn",
    };
  } catch {
    return null;
  }
}
