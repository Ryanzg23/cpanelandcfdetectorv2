import dns from "dns/promises";

/* ================= WHM SERVERS CONFIG ================= */
/* 🔴 REPLACE THESE WITH YOUR ACTUAL SERVERS + ENV TOKENS */
const WHM_SERVERS = [
  {
    name: "SG-1",
    host: "https://15-235-215-150.cprapid.com:2087",
    token: process.env.WHM_SG1
  }
];

/* ================= DOMAIN NORMALIZER ================= */
function normalizeDomain(input) {
  try {
    input = input.trim();
    if (!input.startsWith("http")) input = "http://" + input;
    return new URL(input).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return input.split("/")[0].replace(/^www\./, "").toLowerCase();
  }
}

/* ================= URL NORMALIZER ================= */
function normalizeUrl(input) {
  input = input.trim();
  if (!input.startsWith("http://") && !input.startsWith("https://")) {
    return "http://" + input;
  }
  return input;
}

/* ================= CSV PARSER ================= */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let val = "";
  let inQuotes = false;

  for (let c of text) {
    if (c === '"') inQuotes = !inQuotes;
    else if (c === "," && !inQuotes) {
      row.push(val);
      val = "";
    } else if ((c === "\n" || c === "\r") && !inQuotes) {
      if (row.length || val) {
        row.push(val);
        rows.push(row);
      }
      row = [];
      val = "";
    } else {
      val += c;
    }
  }

  if (row.length || val) {
    row.push(val);
    rows.push(row);
  }

  const headers = rows.shift().map(h => h.trim());
  return rows.map(r => {
    const o = {};
    headers.forEach((h, i) => o[h] = (r[i] || "").trim());
    return o;
  });
}

/* ================= REGISTRAR ================= */
async function getRegistrar(domain) {
  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`);
    if (!res.ok) return "-";
    const data = await res.json();
    return (
      data.entities?.find(e => e.roles?.includes("registrar"))
        ?.vcardArray?.[1]
        ?.find(v => v[0] === "fn")?.[3] || "-"
    );
  } catch {
    return "-";
  }
}

/* ================= WHM DETECTION ================= */
async function detectWhmServer(domain) {
  if (!WHM_SERVERS.length) return { server: "-", user: "-" };

  const checks = WHM_SERVERS.map(async (server) => {
    try {
      const res = await fetch(
        `${server.host}/json-api/listaccts?api.version=1`,
        {
          headers: {
            Authorization: `whm root:${server.token}`
          }
        }
      );

      const data = await res.json();
      const accounts = data?.data?.acct || [];

      for (const a of accounts) {
        const mainDomain = a.domain;
        const user = a.user;

        // normalize addon / parked domains
        const addonDomains = (a.addon_domains || "")
          .split(/\s+/)
          .map(d => d.trim().toLowerCase())
          .filter(Boolean);

        const parkedDomains = (a.parked_domains || "")
          .split(/\s+/)
          .map(d => d.trim().toLowerCase())
          .filter(Boolean);

        const subDomains = (a.sub_domains || "")
          .split(/\s+/)
          .map(d => d.trim().toLowerCase())
          .filter(Boolean);

        if (
          domain === mainDomain ||
          domain === `www.${mainDomain}` ||
          addonDomains.includes(domain) ||
          parkedDomains.includes(domain) ||
          subDomains.includes(domain)
        ) {
          return {
            server: server.name,
            user
          };
        }
      }

    } catch (e) {
      console.log("WHM ERROR:", e);
    }

    return null;
  });

  const results = await Promise.all(checks);
  return results.find(r => r) || { server: "-", user: "-" };
}

/* ================= HTTP DETECTION ================= */
async function detectHttp(inputUrl, maxHops = 6) {
  let trail = [];
  let currentUrl = normalizeUrl(inputUrl);

  try {
    for (let i = 0; i < maxHops; i++) {
      const res = await fetch(currentUrl, {
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (Bulk SEO Meta Viewer)",
          "Accept": "text/html,application/xhtml+xml"
        }
      });

      const server = res.headers.get("server") || "";
      const via = server.toLowerCase().includes("cloudflare")
        ? "Cloudflare"
        : "htaccess";

      trail.push({
        url: currentUrl,
        status: res.status,
        via
      });

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }

    let finalUrl = currentUrl;

    if (finalUrl.startsWith("http://")) {
      try {
        const httpsUrl = finalUrl.replace(/^http:/, "https:");
        const httpsRes = await fetch(httpsUrl, { redirect: "manual" });
        if (httpsRes.status >= 200 && httpsRes.status < 400) {
          trail.push({
            url: httpsUrl,
            status: httpsRes.status,
            via: httpsRes.headers.get("server")?.toLowerCase().includes("cloudflare")
              ? "Cloudflare"
              : "htaccess"
          });
          finalUrl = httpsUrl;
        }
      } catch {}
    }

    const startHost = new URL(normalizeUrl(inputUrl)).hostname.replace(/^www\./, "");
    const finalHost = new URL(finalUrl).hostname.replace(/^www\./, "");

    if (startHost === finalHost) {
      const u = new URL(finalUrl);
      return {
        result: `${u.protocol}//${u.host}${u.pathname}${u.search}`,
        via: trail.at(-1)?.via || "-",
        trail
      };
    }

    return {
      result: `301 to ${finalUrl}`,
      via: trail.at(-1)?.via || "-",
      trail
    };

  } catch {
    return {
      result: "Domain not active",
      via: "-",
      trail: []
    };
  }
}

/* ================= FALLBACK ================= */
function inactiveResult(input) {
  return {
    domain: input,
    cloudflare: "-",
    registrar: "-",
    http_result: "Domain not active",
    http_via: "-",
    http_trail: [],
    nameservers: "-",
    whm_server: "-",
    whm_user: "-"
  };
}

/* ================= PARALLEL RUNNER ================= */
async function runWithConcurrency(items, limit, worker) {
  const results = [];
  const queue = items.map((item, index) => ({ item, index }));

  const runners = Array.from({ length: limit }, async () => {
    while (queue.length) {
      const { item, index } = queue.shift();
      try {
        const result = await worker(item);
        results.push({ index, result });
      } catch {
        results.push({ index, result: inactiveResult(item) });
      }
    }
  });

  await Promise.all(runners);

  return results
    .sort((a, b) => a.index - b.index)
    .map(r => r.result);
}

/* ================= MAIN HANDLER ================= */
export async function handler(event) {
  try {
    const body = JSON.parse(event.body || "{}");

    const inputs = [...new Set(
      (body.domains || []).map(d => d.trim()).filter(Boolean)
    )];

    if (!inputs.length) {
      console.log("NO DOMAINS RECEIVED", body);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No domains received", body })
      };
    }

    const BASE =
      "https://docs.google.com/spreadsheets/d/1AtmjzUR_iGHCUE_tYLMAM9BP8Zx37nGiU0g632f2594/export?format=csv&gid=";

    const cfCsv = parseCSV(await (await fetch(BASE + "281551120")).text());
    const pagesCsv = parseCSV(await (await fetch(BASE + "1856733993")).text());

    const pagesMap = {};
    pagesCsv.forEach(r => {
      const d = normalizeDomain(r.Domain);
      if (d) pagesMap[d] = r.Cloudflare;
    });

    
    const cfNs = cfCsv.map(r => ({
      email: r["Cloudflare Email"],
      ns1: r["Nameserver 1"]?.toLowerCase(),
      ns2: r["Nameserver 2"]?.toLowerCase()
    }));

    const results = await runWithConcurrency(inputs, 5, async (input) => {
      const hostname = normalizeDomain(input);

      const [http, whm] = await Promise.all([
        detectHttp(input),
        detectWhmServer(hostname)
      ]);

      if (hostname.endsWith(".pages.dev")) {
        return {
          domain: input,
          cloudflare: pagesMap[hostname] || "Not listed",
          registrar: "Cloudflare, Inc.",
          http_result: http.result,
          http_via: http.via,
          http_trail: http.trail,
          nameservers: "-",
          whm_server: "-",
          whm_user: "-"
        };
      }

      let nameservers = [];
      try {
        nameservers = (await dns.resolveNs(hostname))
          .map(n => n.replace(/\.$/, "").toLowerCase());
      } catch {}

      let cloudflare = "-";
      for (const r of cfNs) {
        if (nameservers.includes(r.ns1) && nameservers.includes(r.ns2)) {
          cloudflare = r.email;
          break;
        }
      }

      return {
        domain: input,
        cloudflare,
        registrar: await getRegistrar(hostname),
        http_result: http.result,
        http_via: http.via,
        http_trail: http.trail,
        nameservers: nameservers.length ? nameservers.join(", ") : "-",
        whm_server: whm.server,
        whm_user: whm.user
      };
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(results)
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
