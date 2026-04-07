import dns from "dns/promises";

/* ================= WHM CONFIG ================= */
const WHM_SERVERS = [
  {
    name: "SG-1",
    host: "https://15-235-215-150.cprapid.com:2087",
    token: process.env.WHM_SG1
  }
];

let WHM_CACHE = null;

/* ================= WHM DETECTION (MAIN ONLY) ================= */
async function buildWhmCache() {
  if (WHM_CACHE) return WHM_CACHE;

  WHM_CACHE = {};

  for (const server of WHM_SERVERS) {
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

      WHM_CACHE[server.name] = accounts.map(a => ({
        domain: a.domain.toLowerCase(),
        user: a.user
      }));

    } catch (e) {
      console.log("WHM ERROR:", e.message);
    }
  }

  return WHM_CACHE;
}

async function detectWhmServer(domain) {
  const cache = await buildWhmCache();

  domain = domain.toLowerCase();

  for (const serverName in cache) {
    for (const acc of cache[serverName]) {
      if (
        acc.domain === domain ||
        acc.domain === domain.replace(/^www\./, "")
      ) {
        return {
          server: serverName,
          user: acc.user
        };
      }
    }
  }

  return { server: "-", user: "-" };
}



async function detectAddonDomain(domain) {
  for (const server of WHM_SERVERS) {
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

      // 🔥 limit to avoid timeout
      for (const a of accounts.slice(0, 20)) {
        try {
          const res2 = await fetch(
            `${server.host}/json-api/domainuserdata?api.version=1&user=${a.user}`,
            {
              headers: {
                Authorization: `whm root:${server.token}`
              }
            }
          );

          const data2 = await res2.json();
          const userdata = data2?.data?.userdata || {};

          if (userdata[domain]) {
            return {
              server: server.name,
              user: a.user
            };
          }

        } catch {}
      }

    } catch {}
  }

  return { server: "-", user: "-" };
}

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

/* ================= HTTP DETECTION ================= */
async function detectHttp(inputUrl, maxHops = 6) {
  let trail = [];
  let currentUrl = normalizeUrl(inputUrl);

  try {
    for (let i = 0; i < maxHops; i++) {
      const res = await fetch(currentUrl, {
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html"
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

    return {
      result: currentUrl,
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
        results.push({ index, result: { domain: item } });
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
      return { statusCode: 400, body: "No domains provided" };
    }

    /* 🔥 build WHM cache once */
    await buildWhmCache();

    const results = await runWithConcurrency(inputs, 5, async (input) => {
      const hostname = normalizeDomain(input);

      const http = await detectHttp(input);

      /* ===== NS ===== */
      let nameservers = [];
      try {
        nameservers = (await dns.resolveNs(hostname))
          .map(n => n.replace(/\.$/, "").toLowerCase());
      } catch {}

      /* ===== CF ===== */
      let cloudflare = "-";
      if (nameservers.some(ns => ns.includes("cloudflare.com"))) {
        cloudflare = "Cloudflare";
      }

      /* ===== WHM ===== */
      let whm = await detectWhmServer(hostname);
      
      // 🔥 ONLY try addon detection for 1st few domains (avoid overload)
      if (whm.server === "-" && Math.random() < 0.2) {
        const addon = await detectAddonDomain(hostname);
        if (addon.server !== "-") {
          whm = addon;
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

        // ✅ NEW FIELD (your table already supports this)
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
