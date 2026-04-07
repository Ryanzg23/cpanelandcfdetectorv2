import dns from "dns/promises";

const WHM_SERVERS = [
  {
    name: "SG-1",
    host: "https://15-235-215-150.cprapid.com:2087",
    token: process.env.WHM_SG1
  }
];

// 🔥 GLOBAL CACHE (persists while function is warm)
let DOMAIN_MAP = null;
let LAST_BUILD = 0;
const CACHE_TTL = 1000 * 60 * 5; // 5 minutes

// 🧠 Build FULL domain map (main + addon + sub)
async function buildDomainMap() {
  const now = Date.now();

  if (DOMAIN_MAP && (now - LAST_BUILD < CACHE_TTL)) {
    return DOMAIN_MAP;
  }

  console.log("🔄 Building WHM domain map...");

  DOMAIN_MAP = {};

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

      console.log(`📦 ${server.name}: ${accounts.length} accounts`);

      // 🔥 LIMIT users processed (prevents timeout)
      const LIMITED_ACCOUNTS = accounts.slice(0, 50);

      for (const a of LIMITED_ACCOUNTS) {
        const user = a.user;

        // ✅ Always include main domain
        DOMAIN_MAP[a.domain.toLowerCase()] = {
          server: server.name,
          user
        };

        try {
          const res2 = await fetch(
            `${server.host}/json-api/domainuserdata?api.version=1&user=${user}`,
            {
              headers: {
                Authorization: `whm root:${server.token}`
              }
            }
          );

          const data2 = await res2.json();
          const userdata = data2?.data?.userdata || {};

          for (const d in userdata) {
            DOMAIN_MAP[d.toLowerCase()] = {
              server: server.name,
              user
            };
          }

        } catch (e) {
          console.log(`⚠️ USERDATA ERROR (${user})`);
        }
      }

    } catch (e) {
      console.log("❌ WHM ERROR:", e.message);
    }
  }

  LAST_BUILD = now;

  console.log(`✅ Domain map built (${Object.keys(DOMAIN_MAP).length} domains)`);

  return DOMAIN_MAP;
}
// 🔍 Detect domain from cache
async function detectWhmServer(domain) {
  const map = await buildDomainMap();

  domain = domain.toLowerCase();

  return (
    map[domain] ||
    map[domain.replace(/^www\./, "")] ||
    { server: "-", user: "-" }
  );
}

// 🌐 Basic HTTP check
async function checkHttp(domain) {
  try {
    const url = `https://${domain}`;
    const res = await fetch(url, { redirect: "follow" });

    return {
      result: res.url,
      status: res.status
    };
  } catch {
    return {
      result: "-",
      status: "-"
    };
  }
}

// 🧾 MAIN HANDLER
export async function handler(event) {
  try {
    const body = JSON.parse(event.body || "{}");
    const domains = body.domains || [];

    if (!domains.length) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No domains provided" })
      };
    }

    const results = [];

    for (const d of domains) {
      const domain = d.trim();

      // HTTP
      const http = await checkHttp(domain);

      // WHM detection
      const whm = await detectWhmServer(domain);

      results.push({
        domain,
        http_result: http.result,
        http_status: http.status,
        whm_server: whm.server,
        whm_user: whm.user
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify(results)
    };

  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
}
