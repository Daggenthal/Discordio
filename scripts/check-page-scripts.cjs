// CI check: // Evaluate the page scripts with stubbed browser globals; fail on load-time errors.
const fs = require("fs"), vm = require("vm");
const deep = () => new Proxy(function () {}, {
  get: (t, k) => k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : deep(),
  apply: () => deep(), construct: () => deep(),
});
const ctx = { console, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  WebSocket: function () { this.readyState = 0; }, document: deep(), navigator: deep(), location: { pathname: "/", href: "https://discord.com/app" },
  HTMLMediaElement: function () {}, RTCPeerConnection: function () {}, MediaStream: function () {}, Vencord: undefined,
  addEventListener() {}, dispatchEvent() {}, performance: { now: () => 0 }, localStorage: deep(), JSON, Math, Date, Promise, Object, Array, Set, Map, WeakMap, WeakRef, Proxy, Reflect, Error, String, Number, Boolean, RegExp, BigInt, Symbol };
ctx.HTMLMediaElement.prototype.play = function () {};
ctx.window = ctx; ctx.top = ctx; ctx.self = ctx; ctx.globalThis = ctx;
ctx.DISCORDIO_CONFIG = {};
vm.createContext(ctx);
let bad = 0;
for (const f of process.argv.slice(2)) {
  try { vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f }); }
  catch (e) { bad++; console.error(`${f}: ${e && e.stack || e}`); }
}
if (!ctx.DISCORDIO) { console.error("window.DISCORDIO was never set"); bad++; }
process.exit(bad ? 1 : 0);
