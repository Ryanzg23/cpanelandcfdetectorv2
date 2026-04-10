import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = 3000;

/* ================= WHM CONFIG ================= */
const WHM_SERVERS = [
  {
    name: "SG_1",
    host: "https://15-235-215-150.cprapid.com:2087",
    token: process.env.WHM_SG1
  },
  {
    name: "SG_2",
    host: "https://ns5026652.ip-15-235-216.net:2087",
    token: process.env.WHM_SG2
  },
  {
    name: "SG_3",
    host: "https://vps-d7d292c8.vps.ovh.ca:2087",
    token: process.env.WHM_SG3
  },
  {
    name: "GD_MAH_IP1",
    host: "https://184.124.168.184.host.secureserver.net:2087",
    token: process.env.GD_MAH_IP1
  },
  {
    name: "GD_MAH_IP2",
    host: "https://148.66.156.54.host.secureserver.net:2087",
    token: process.env.GD_MAH_IP2
  },
  {
    name: "GD_MAH_IP3",
    host: "https://148.66.153.181.host.secureserver.net:2087",
    token: process.env.GD_MAH_IP3
  },
  {
    name: "NC_MAH_IP1",
    host: "https://server1.maha168ku.com:2087",
    token: process.env.NC_MAH_IP1
  },
  {
    name: "NC_MAH_IP2",
    host: "https://server2.maha168ku.com:2087",
    token: process.env.NC_MAH_IP2
  },
  {
    name: "NC_MAH_IP3",
    host: "https://server3.maha168ku.com:2087",
    token: process.env.NC_MAH_IP3
  },
  {
    name: "GD_USL",
    host: "https://1.88.74.97.host.secureserver.net:2087",
    token: process.env.GD_USL
  }
];

/* ================= CACHE ================= */
let WHM_CACHE = null;

/* ================= BUILD CACHE ================= */
async function buildCache() {
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
      WHM_CACHE[server.name] = [];
    }
  }

  return WHM_CACHE;
}

/* ================= DETECT ================= */
app.post("/detect", async (req, res) => {
  const { domains } = req.body;

  const cache = await buildCache();

  const results = domains.map(domain => {
    domain = domain.toLowerCase();

    for (const server in cache) {
      const found = cache[server].find(d => d.domain === domain);
      if (found) {
        return {
          domain,
          whm_server: server,
          whm_user: found.user
        };
      }
    }

    return {
      domain,
      whm_server: "-",
      whm_user: "-"
    };
  });

  res.json(results);
});

app.listen(PORT, () => {
  console.log("Proxy running on port", PORT);
});
