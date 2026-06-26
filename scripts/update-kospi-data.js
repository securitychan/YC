const https = require("https");
const fs = require("fs");
const path = require("path");

const YAHOO_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?range=5y&interval=1d&includePrePost=false&events=history";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json,text/plain,*/*",
        },
        timeout: 15000,
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Yahoo Finance returned ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error("Yahoo Finance request timed out")));
    req.on("error", reject);
  });
}

function round(value, digits = 2) {
  if (value == null || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toDate(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function getZone(disparity) {
  if (disparity == null) return "unknown";
  if (disparity >= 130) return "overheated";
  if (disparity >= 120) return "warning";
  if (disparity > 105) return "normal";
  return "cooled";
}

function getZoneLabel(zone) {
  return {
    overheated: "\uACFC\uC5F4",
    warning: "\uACBD\uACC4",
    normal: "\uC815\uC0C1",
    cooled: "\uACFC\uC5F4\uD574\uC18C",
    unknown: "\uB370\uC774\uD130 \uC900\uBE44 \uC911",
  }[zone];
}

function buildPayload(raw) {
  const result = raw?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const points = [];
  const window = [];
  let sum = 0;

  for (let index = 0; index < timestamps.length; index += 1) {
    const close = closes[index];
    if (close == null || Number.isNaN(close)) continue;

    window.push(close);
    sum += close;
    if (window.length > 50) sum -= window.shift();

    const ma50 = window.length === 50 ? sum / 50 : null;
    const disparity = ma50 ? (close / ma50) * 100 : null;
    const zone = getZone(disparity);

    points.push({
      date: toDate(timestamps[index]),
      close: round(close, 2),
      ma50: round(ma50, 2),
      disparity: round(disparity, 2),
      zone,
      zoneLabel: getZoneLabel(zone),
    });
  }

  const completePoints = points.filter((point) => point.ma50 != null);

  return {
    symbol: "^KS11",
    name: "KOSPI Composite Index",
    source: "Yahoo Finance chart API - GitHub Actions auto update",
    fetchedAt: new Date().toISOString(),
    marketTime: result?.meta?.regularMarketTime
      ? new Date(result.meta.regularMarketTime * 1000).toISOString()
      : null,
    latest: completePoints.at(-1) || null,
    points: completePoints,
  };
}

function readExistingPayload(outputPath) {
  if (!fs.existsSync(outputPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } catch {
    return null;
  }
}

function isNewerPayload(candidate, current) {
  if (!candidate?.latest?.date) return false;
  if (!current?.latest?.date) return true;
  if (candidate.latest.date !== current.latest.date) {
    return candidate.latest.date > current.latest.date;
  }
  return (candidate.fetchedAt || "") > (current.fetchedAt || "");
}

function writePayload(outputPath, payload) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const outputPath = path.join(__dirname, "..", "public", "data", "kospi.json");
  const existing = readExistingPayload(outputPath);

  let fetched = null;
  try {
    fetched = buildPayload(await fetchJson(YAHOO_URL));
  } catch (error) {
    if (existing?.latest?.date) {
      console.warn(`Fetch failed, keeping existing data: ${existing.latest.date}`);
      return;
    }
    throw error;
  }

  const selected = isNewerPayload(fetched, existing) ? fetched : existing;
  writePayload(outputPath, selected);

  const mode = selected === fetched ? "updated" : "kept existing newer";
  console.log(`${mode}: ${selected.points.length} records, latest ${selected.latest.date}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
