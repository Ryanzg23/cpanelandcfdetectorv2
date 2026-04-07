import dns from "dns/promises";

const WHM_SERVERS = [
  {
    name: "SG-1",
    host: "https://15-235-215-150.cprapid.com:2087",
    token: process.env.WHM_SG1
  }
];

// 🔥 simple cache
let WHM_CACHE = null;

// 🧠 Build cache (MAIN DOMAINS ONLY)
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

// 🔍 Detect (MAIN DOMAIN ONLY)
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

// 🌐 HTTP check
async function checkHttp(domain) {
  try {
    const res = await fetch(`https://${domain}`, {
      redirect: "follow"
    });

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

    // 🔥 build cache once
    await buildWhmCache();

    const results = await Promise.all(
      domains.map(async (d) => {
        const domain = d.trim();

        const http = await checkHttp(domain);
        const whm = await detectWhmServer(domain);

        return {
          domain,
          http_result: http.result,
          http_status: http.status,
          whm_server: whm.server,
          whm_user: whm.user
        };
      })
    );

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
