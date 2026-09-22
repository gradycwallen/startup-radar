// Preload (node --import) that makes ANY network attempt fail loudly AND leaves a trace, so a test can prove
// that a code path never tried to reach the network even if it swallowed the error.
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";

const trace = process.env.NO_NETWORK_LOG;
function blocked(what) {
  if (trace) fs.appendFileSync(trace, `${what}\n`);
  throw new Error(`NETWORK BLOCKED: ${what}`);
}
globalThis.fetch = (input) => blocked(`fetch ${typeof input === "string" ? input : (input && input.url) || String(input)}`);
net.Socket.prototype.connect = function (...args) { return blocked(`net.connect ${JSON.stringify(args[0])}`); };
tls.connect = (...args) => blocked(`tls.connect ${JSON.stringify(args[0])}`);
dns.lookup = (host) => blocked(`dns.lookup ${host}`);
