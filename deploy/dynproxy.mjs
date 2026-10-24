#!/usr/bin/env node
// dynproxy — dynamic-egress SOCKS5 proxy.
// The DESIRED EGRESS IP is carried as the SOCKS5 USERNAME (password is the fixed
// secret). Any IP bound on this host works the moment it exists — zero per-IP
// configuration. Outbound sockets are bound to the chosen source address, so no
// SNAT is needed. Run with host networking.
import net from "node:net";
import os from "node:os";

const PORT = parseInt(process.env.DYNPROXY_PORT || "1080", 10);
const SECRET = process.env.DYNPROXY_SECRET || "cpx:d221ea9e1fbae90a"; // "user prefix not used; password only"
const PASSWORD = process.env.DYNPROXY_PASSWORD || SECRET.split(":")[1];

const localAddresses = () => {
  const set = new Set(["127.0.0.1"]);
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces || []) if (i.family === "IPv4") set.add(i.address);
  return set;
};
let local4 = localAddresses();
setInterval(() => { local4 = localAddresses(); }, 30_000);

function serve(conn) {
  let stage = 0; // 0=greeting 1=auth 2=request
  let egress = null;
  conn.on("data", function onData(buf) {
    try {
      if (stage === 0) {
        if (buf[0] !== 5) throw new Error("not socks5");
        if (!buf.includes(2)) { conn.write(Buffer.from([5, 0xff])); return conn.end(); } // no auth support
        conn.write(Buffer.from([5, 2])); stage = 1;
      } else if (stage === 1) {
        // RFC1929 user/pass subnegotiation: ver ulen user plen pass
        const ulen = buf[1], user = buf.slice(2, 2 + ulen).toString();
        const plen = buf[2 + ulen], pass = buf.slice(3 + ulen, 3 + ulen + plen).toString();
        if (pass !== PASSWORD || !local4.has(user)) { conn.write(Buffer.from([1, 1])); return conn.end(); }
        egress = user;
        conn.write(Buffer.from([1, 0])); stage = 2;
      } else if (stage === 2) {
        if (buf[1] !== 1) { conn.write(Buffer.from([5, 7])); return conn.end(); } // CONNECT only
        const atyp = buf[3];
        let host, port = buf.readUInt16BE(buf.length - 2);
        if (atyp === 1) host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        else if (atyp === 3) host = buf.slice(5, 5 + buf[4]).toString();
        else { conn.write(Buffer.from([5, 8])); return conn.end(); }
        conn.removeListener("data", onData);
        const out = net.connect({ host, port, localAddress: egress }, () => {
          conn.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          out.pipe(conn); conn.pipe(out);
        });
        out.on("error", () => { try { conn.write(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])); conn.end(); } catch {} });
      }
    } catch { conn.end(); }
  });
  conn.on("error", () => {});
}

net.createServer(serve).listen(PORT, "127.0.0.1", () => {
  console.log(`[dynproxy] :${PORT} — username = egress IP (local IPv4 set: ${[...local4].filter((x) => !x.startsWith("127.")).join(", ")})`);
});
