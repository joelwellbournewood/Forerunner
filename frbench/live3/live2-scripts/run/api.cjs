// usage: node api.cjs <bench> <METHOD> <route> [jsonbody]
process.env.FRBENCH_ROOT = process.env.FRBENCH_ROOT || "/tmp/frbench/live2/run";
const R = require("/home/user/Forerunner/scripts/bench/recorder.cjs");
const [name, method, route, body] = process.argv.slice(2);
R.apiRaw(name, method, route, body ? JSON.parse(body) : undefined).then((r) => {
  console.log(r.status, JSON.stringify(r.body, null, 2));
}).catch((e) => { console.error(e); process.exit(1); });
