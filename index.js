const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

admin.initializeApp();
const db = admin.firestore();

// ─── SECRETS & CONSTANTS ──────────────────────────────────────────
const API_KEY      = defineSecret("API_SPORTS_KEY");
const SUPABASE_URL = defineSecret("SUPABASE_URL");
const SUPABASE_KEY = defineSecret("SUPABASE_KEY");

const BASE_URL = "https://v3.football.api-sports.io";
const TIMEZONE = "Europe/Istanbul";

const LEAGUE_IDS = new Set([
  39, 40, 41, 42, 43, 50, 51, 140, 141, 135, 136,
  78, 79, 61, 62, 203, 204, 205, 552, 553,
  554, 1027, 2, 3, 4, 88, 145, 179, 94, 188, 218,
  207, 345, 119, 357, 106, 286, 210, 172, 244, 265,
  103, 113, 204, 419, 128, 262, 239, 253, 116, 206
]);

function getCurrentSeason() {
  const now = new Date();
  return now.getMonth() < 6 ? now.getFullYear() - 1 : now.getFullYear();
}

function getSupabase(url, key) {
  return createClient(url, key);
}

// ─── CACHE ────────────────────────────────────────────────────────
async function getCache(key) {
  try {
    const doc = await db.collection("cache").doc(key).get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (data.expiresAt && data.expiresAt.toMillis() < Date.now()) return null;
    return data.response;
  } catch { return null; }
}

async function setCache(key, response, ttlSeconds) {
  try {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await db.collection("cache").doc(key).set({
      response,
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) { console.error("Cache yazma hatası:", err.message); }
}

function cacheKey(parts) {
  return parts.join("_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ─── RATE LIMITING ────────────────────────────────────────────────
const RATE_LIMIT  = 30;
const RATE_WINDOW = 60;

async function checkRateLimit(req, res) {
  const ip     = (req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "unknown").trim();
  const minute = Math.floor(Date.now() / (RATE_WINDOW * 1000));
  const key    = `rate_${ip}_${minute}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  try {
    const ref     = db.collection("rate_limits").doc(key);
    const allowed = await db.runTransaction(async (t) => {
      const doc   = await t.get(ref);
      const count = doc.exists ? doc.data().count : 0;
      if (count >= RATE_LIMIT) return false;
      t.set(ref, {
        count:     count + 1,
        expiresAt: admin.firestore.Timestamp.fromMillis((minute + 1) * RATE_WINDOW * 1000),
      });
      return true;
    });
    if (!allowed) { res.status(429).json({ error: "Çok fazla istek. 1 dakika bekleyin." }); return false; }
    return true;
  } catch { return true; }
}

// ─────────────────────────────────────────────────────────────────
// 1. MAÇLARI TARİHE GÖRE GETİR
//
// YALNIZCA GEÇMİŞ TARİHLER → Firestore archive_matches
//
// Bugünkü maçlar artık Flutter'ın Supabase'e doğrudan erişimiyle
// çekilir. Bu fonksiyon çağrılmamalı; yanlışlıkla çağrılırsa 400.
// ─────────────────────────────────────────────────────────────────
exports.maclarByDate = onRequest(
  {},
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "date gerekli (YYYY-MM-DD)" });

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Istanbul" });

    // Bugün için bu endpoint'e gelinmemeli — Flutter direkt Supabase'e gider
    if (date === today) {
      return res.status(400).json({
        error: "Bugünkü maçlar için bu endpoint kullanılamaz. Flutter direkt Supabase'e erişmeli.",
      });
    }

    try {
      // Arşiv: ana döküman içindeki fixtures dizisi
      const dateDocRef = db.collection("archive_matches").doc(date);
      const dateDoc    = await dateDocRef.get();

      if (dateDoc.exists && Array.isArray(dateDoc.data()?.fixtures) && dateDoc.data().fixtures.length > 0) {
        const fixtures = dateDoc.data().fixtures.filter(m =>
          ["FT", "AET", "PEN"].includes(m?.fixture?.status?.short)
        );
        return res.json({ response: fixtures });
      }

      // Arşiv: alt koleksiyon yapısı
      const snapshot = await dateDocRef.collection("fixtures").get();
      if (!snapshot.empty) {
        const fixtures = [];
        snapshot.forEach(doc => {
          const m = doc.data();
          if (["FT", "AET", "PEN"].includes(m?.fixture?.status?.short)) fixtures.push(m);
        });
        return res.json({ response: fixtures });
      }

      return res.status(404).json({ error: `${date} için arşiv bulunamadı` });
    } catch (err) {
      console.error("maclarByDate hatası:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────
// 2. CANLI MAÇ DETAYI (events / stats / lineups / h2h / standings)
//
// API-Football'a HİÇ gitmez — sadece Supabase tablolarını okur.
// ─────────────────────────────────────────────────────────────────
exports.macDetay = onRequest(
  { secrets: [SUPABASE_URL, SUPABASE_KEY], enforceAppCheck: true },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (!await checkRateLimit(req, res)) return;

    const { endpoint, fixtureId, homeId, awayId } = req.query;
    const supabase = getSupabase(SUPABASE_URL.value(), SUPABASE_KEY.value());

    try {
      let data = null;

      if (endpoint === "fixtures/headtohead") {
        const h2hKey              = `${homeId}-${awayId}`;
        const { data: resH2H }    = await supabase.from("match_h2h").select("data").eq("h2h_key", h2hKey).maybeSingle();
        data = resH2H?.data;
      } else if (endpoint === "standings") {
        const { data: resStandings } = await supabase.from("league_standings").select("data").eq("league_id", fixtureId).maybeSingle();
        data = resStandings?.data;
      } else if (endpoint === "fixtures/events") {
        const { data: resEvents } = await supabase.from("match_events").select("*").eq("fixture_id", fixtureId).order("elapsed_time", { ascending: true });
        data = resEvents;
      } else if (endpoint === "fixtures/statistics") {
        const { data: resStats }  = await supabase.from("match_statistics").select("data").eq("fixture_id", fixtureId).maybeSingle();
        data = resStats?.data;
      } else if (endpoint === "fixtures/lineups") {
        const { data: resLineups } = await supabase.from("match_lineups").select("data").eq("fixture_id", fixtureId).maybeSingle();
        data = resLineups?.data;
      }

      return data
        ? res.json({ response: data, source: "supabase" })
        : res.json({ response: [], message: "Veri henüz hazır değil." });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────
// 3. ARŞİV MAÇ DETAYI — Firestore archive_matches (KORUNDU)
// ─────────────────────────────────────────────────────────────────
exports.arsivMacDetay = onRequest(
  { enforceAppCheck: true },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (!await checkRateLimit(req, res)) return;

    const { fixtureId, date, type = "events" } = req.query;
    if (!fixtureId || !date) return res.status(400).json({ error: "fixtureId ve date gerekli" });

    try {
      const matchRef = db.collection("archive_matches").doc(date).collection("fixtures").doc(fixtureId);
      let match      = null;
      const matchDoc = await matchRef.get();

      if (matchDoc.exists) {
        match = matchDoc.data();
      } else {
        const dateDoc = await db.collection("archive_matches").doc(date).get();
        if (dateDoc.exists) {
          const fixtures = dateDoc.data()?.fixtures ?? [];
          match = fixtures.find(m => String(m.fixture?.id) === String(fixtureId)) || null;
        }
      }

      if (!match) return res.status(404).json({ error: `Maç bulunamadı: ${fixtureId}` });

      // Hangi field'lar mevcut — debug için
      const availableKeys = Object.keys(match);
      console.log(`[arsivMacDetay] fixtureId=${fixtureId} type=${type} keys=${availableKeys.join(',')}`);

      if (type === "events") {
        const data = match.events ?? match.fixtureEvents ?? match.event ?? [];
        return res.json({ response: data, _keys: availableKeys });
      }

      if (type === "lineups") {
        const data = match.lineups ?? match.lineup ?? match.fixtureLineups ?? {};
        return res.json({ response: data, _keys: availableKeys });
      }

      if (type === "standings") {
        const data = match.standings ?? match.leagueStandings ?? match.standing ?? [];
        return res.json({ response: data, _keys: availableKeys });
      }

      if (type === "h2h") {
        const data = match.h2h ?? match.headToHead ?? match.headtohead ?? null;
        return res.json({ response: data, _keys: availableKeys });
      }

      if (type === "stats") {
        const data = match.stats
          ?? match.statistics
          ?? match.fixtureStatistics
          ?? match.teamStatistics
          ?? [];
        return res.json({ response: data, _keys: availableKeys });
      }

      if (type === "logos") {
        return res.json({ response: {
          homeLogo: match.teams?.home?.logo || null,
          awayLogo: match.teams?.away?.logo || null,
        }});
      }

      return res.json({ response: match });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────
// 4. FAVORİ MAÇLAR (ID'ye göre)
//
// Flutter direkt Supabase'e gidebilir ama bu endpoint eski
// istemcilerle uyumlu kalması için korundu.
// ─────────────────────────────────────────────────────────────────
exports.maclarByIds = onRequest(
  { secrets: [SUPABASE_URL, SUPABASE_KEY] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    const idsParam = req.query.ids;
    if (!idsParam) { res.status(400).json({ error: "ids gerekli" }); return; }

    try {
      const idArray  = idsParam.split("-").map(id => parseInt(id)).filter(Boolean);
      const supabase = getSupabase(SUPABASE_URL.value(), SUPABASE_KEY.value());

      const { data, error } = await supabase
        .from("live_matches")
        .select("raw_data, fixture_id, home_team, away_team, home_team_id, away_team_id, home_logo, away_logo, home_score, away_score, status_short, elapsed_time, league_id, league_name, league_logo")
        .in("fixture_id", idArray);

      if (error) throw new Error(error.message);

      // raw_data varsa onu kullan, yoksa kolonlardan iç-içe format oluştur
      const formattedData = data.map(row => {
        if (row.raw_data) return row.raw_data;
        return _rowToNestedJson(row);
      }).filter(Boolean);

      res.json({ response: formattedData });
    } catch (err) {
      console.error("maclarByIds hatası:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Yardımcı: Supabase satırını API-Football iç-içe formatına çevir ───
function _rowToNestedJson(row) {
  return {
    fixture: {
      id:     row.fixture_id,
      status: { short: row.status_short, elapsed: row.elapsed_time, extra: null },
    },
    league: {
      id:   row.league_id,
      name: row.league_name || "",
      logo: row.league_logo || "",
    },
    teams: {
      home: { id: row.home_team_id, name: row.home_team || "", logo: row.home_logo || "" },
      away: { id: row.away_team_id, name: row.away_team || "", logo: row.away_logo || "" },
    },
    goals: { home: row.home_score, away: row.away_score },
  };
}

// ─── 5. TAKIM ARA ─────────────────────────────────────────────────
exports.takimAra = onRequest(
  { secrets: [API_KEY], enforceAppCheck: true },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (!await checkRateLimit(req, res)) return;
    const q = req.query.q;
    if (!q || q.length < 3) { res.status(400).json({ error: "En az 3 karakter girin" }); return; }
    try {
      const key    = cacheKey(["team_search", q.toLowerCase()]);
      const cached = await getCache(key);
      if (cached !== null) { res.json({ response: cached, fromCache: true }); return; }
      const response = await axios.get(`${BASE_URL}/teams`, {
        params: { search: q },
        headers: { "x-apisports-key": API_KEY.value() },
      });
      await setCache(key, response.data.response, 7 * 24 * 3600);
      res.json({ response: response.data.response });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

// ─── 6. TAKIM MAÇLARI ─────────────────────────────────────────────
exports.takimMaclari = onRequest(
  { secrets: [API_KEY], enforceAppCheck: true },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (!await checkRateLimit(req, res)) return;
    const teamId = req.query.teamId;
    if (!teamId) { res.status(400).json({ error: "teamId gerekli" }); return; }
    try {
      const key    = cacheKey(["team_fixtures", teamId, getCurrentSeason()]);
      const cached = await getCache(key);
      if (cached !== null) { res.json({ response: cached, fromCache: true }); return; }
      const response = await axios.get(`${BASE_URL}/fixtures`, {
        params: { team: teamId, season: getCurrentSeason(), timezone: TIMEZONE },
        headers: { "x-apisports-key": API_KEY.value() },
      });
      await setCache(key, response.data.response, 6 * 3600);
      res.json({ response: response.data.response });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

// ─── 7. TAKIM KADROSU ─────────────────────────────────────────────
exports.takimKadro = onRequest(
  { secrets: [API_KEY], enforceAppCheck: true },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (!await checkRateLimit(req, res)) return;
    const teamId = req.query.teamId;
    if (!teamId) { res.status(400).json({ error: "teamId gerekli" }); return; }
    try {
      const key    = cacheKey(["team_squad", teamId, getCurrentSeason()]);
      const cached = await getCache(key);
      if (cached !== null) { res.json({ response: cached, fromCache: true }); return; }
      const response = await axios.get(`${BASE_URL}/players/squads`, {
        params: { team: teamId },
        headers: { "x-apisports-key": API_KEY.value() },
      });
      await setCache(key, response.data.response, 7 * 24 * 3600);
      res.json({ response: response.data.response });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

// ─── 8. TAKIM İSTATİSTİKLERİ ──────────────────────────────────────
exports.takimStats = onRequest(
  { secrets: [API_KEY], enforceAppCheck: true },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (!await checkRateLimit(req, res)) return;
    const teamId = req.query.teamId;
    if (!teamId) { res.status(400).json({ error: "teamId gerekli" }); return; }
    try {
      const key    = cacheKey(["team_stats", teamId, getCurrentSeason()]);
      const cached = await getCache(key);
      if (cached !== null) { res.json({ response: cached, fromCache: true }); return; }
      const fixturesResp = await axios.get(`${BASE_URL}/fixtures`, {
        params: { team: teamId, season: getCurrentSeason(), last: 1 },
        headers: { "x-apisports-key": API_KEY.value() },
      });
      const fixtures = fixturesResp.data.response;
      if (fixtures.length === 0) { res.status(404).json({ error: "Takım bu sezon maç oynamadı" }); return; }
      const leagueId  = fixtures[0].league.id;
      const statsResp = await axios.get(`${BASE_URL}/teams/statistics`, {
        params: { team: teamId, league: leagueId, season: getCurrentSeason() },
        headers: { "x-apisports-key": API_KEY.value() },
      });
      await setCache(key, statsResp.data.response, 24 * 3600);
      res.json({ response: statsResp.data.response });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

// ─── 9. GELECEKTEKİ TARİHİN MAÇLARI ─────────────────────────────
exports.gelecekMaclariGetir = onRequest(
  { secrets: [API_KEY] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "YYYY-MM-DD formatında tarih gönderin." });
    }

    try {
      const response = await axios.get(`${BASE_URL}/fixtures`, {
        params:  { date, timezone: "Europe/Istanbul" },
        headers: { "x-apisports-key": API_KEY.value() },
      });
      const validFixtures = (response.data.response || []).filter(f => LEAGUE_IDS.has(f.league.id));
      res.json({ response: validFixtures });
    } catch (err) {
      res.status(500).json({ error: "Maçlar çekilemedi." });
    }
  }
);

// ─── 10. DUMMY BUGÜNÜ GÜNCELLE ────────────────────────────────────
exports.bugunuGuncelle = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.json({ success: true, message: "Koyeb botu devrede." });
});
