// Probe 3: can the render/orchestration step live inside a Solari sandbox? (node? ffmpeg? apt? RTT to gateway?)
import { SandboxClient } from "@solarisdk/sandbox";
const t0 = Date.now(); const log = (...a) => console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s]`, ...a);
const client = new SandboxClient({ apiKey: process.env.SOLARI_API_KEY, baseUrl: process.env.SOLARI_BASE_URL || "https://api.getsolari.com" });
const kill = setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(9); }, 280_000);
for (const template of ["base", "code"]) {
  let sb;
  try {
    const c0 = Date.now();
    sb = await client.create({ template, timeoutMs: 240_000, cpu: 2, memMb: 2048 });
    await sb.connect();
    log(`template=${template} created+connected in ${Date.now()-c0} ms; id=${sb.id}`);
    const sh = async (cmd, timeoutMs = 120_000) => { const r = await sb.commands.run("sh", { args: ["-c", cmd], timeoutMs }); return (r.stdout + (r.stderr ? "\nERR: " + r.stderr : "")).trim(); };
    log("tools:\n" + await sh("echo node=$(node -v 2>&1); echo npm=$(npm -v 2>&1); echo python=$(python3 -V 2>&1); echo ffmpeg=$(ffmpeg -version 2>&1 | head -1); echo apt=$(which apt-get); echo nproc=$(nproc); echo mem=$(free -m | awk '/Mem/{print $2}')MB; echo disk=$(df -h / | awk 'NR==2{print $4}') free; echo os=$(. /etc/os-release; echo $PRETTY_NAME); echo kernel=$(uname -r)"));
    log("egress:\n" + await sh("curl -s -o /dev/null -w 'api.getsolari.com http=%{http_code} connect=%{time_connect}s total=%{time_total}s\\n' https://api.getsolari.com/ ; curl -s -o /dev/null -w 'registry.npmjs.org http=%{http_code} total=%{time_total}s\\n' https://registry.npmjs.org/@solarisdk%2fbrowser"));
    if (template === "base") {
      const a0 = Date.now();
      const out = await sh("(apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null) 2>&1 | tail -2; ffmpeg -version 2>&1 | head -1", 240_000);
      log(`apt-get install ffmpeg: ${Date.now()-a0} ms ->\n${out}`);
      const s0 = Date.now(); const snap = await sb.snapshot("probe-ffmpeg"); log(`snapshot with ffmpeg baked: ${snap} in ${Date.now()-s0} ms`);
      try { const del = await client.deleteSnapshot(snap); log("snapshot deleted (probe only)"); } catch (e) { log("snapshot delete:", String(e).slice(0,100)); }
    }
    const pv = await sb.previewUrl(8080).catch(e => ({ err: String(e).slice(0,120) })); log("previewUrl(8080):", JSON.stringify(pv).replace(/token=[^&"]+/g, "token=***"));
  } catch (e) { log(`template=${template} FAILED:`, String(e).slice(0, 300)); }
  finally { if (sb) { await sb.kill().catch(()=>{}); log("killed"); } }
}
clearTimeout(kill); log("done");
