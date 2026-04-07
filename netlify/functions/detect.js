import dns from "dns/promises";

const WHM_SERVERS = [
  {
    name: "SG-1",
    host: "https://15-235-215-150.cprapid.com:2087",
    token: process.env.WHM_SG1
  }
];

let DOMAIN_MAP = null;

// 🔥 Build domain map ONCE per request
async function buildDomainMap() {
  if (DOMAIN_MAP) return DOMAIN_MAP;

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

      // 🔥 LIMIT accounts to avoid timeout (adjust if needed)
      const LIMITED = accounts.slice(0, 15);

      for (const a of LIMITED) {
        const user = a.user;
        const mainDomain = a.domain.toLowerCase();

        // ✅ Always include main domain
        DOMAIN_MAP[mainDomain] = {
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
          console.log(`USERDATA ERROR (${user})`);
        }
      }

    } catch (e) {
      console.log("WHM ERROR:", e.message);
    }
  }

  return DOMAIN_MAP;
}

// 🔍 Detect domain
async function detectWhmServer(domain) {
  const map = await buildDomainMap();

  domain = domain.toLowerCase();

  return (
    map[domain] ||
    map[domain.replace(/^www\./, "")] ||
    { server: "-", user: "-" }
  );
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

    // 🔥 BUILD MAP ONCE HERE
    await buildDomainMap();

    // ⚡ Process domains in parallel
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
      body: JSON.stringify({
        error: e.message
      })
    };
  }
}
