const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/../gps.js', 'utf8');
function setup() {
  let success, failure, calls = 0, clears = 0, now = 100000, state;
  const timers = new Map(); let timerId = 0;
  const c = vm.createContext({ setTimeout: f => { timers.set(++timerId, f); return timerId; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source,c);
  const geo = { watchPosition(s,f) { success=s; failure=f; calls++; return calls; }, clearWatch() { clears++; } };
  const gps = c.CollectorGps.create(geo,s=>state=s,()=>now);
  return { gps, get state(){return state;}, get calls(){return calls;}, get clears(){return clears;},
    tick(ms) {now+=ms;}, fail(code) {failure({code});}, timeout() {for(const f of [...timers.values()])f();},
    fix(age=0) {success({timestamp:now-age,coords:{latitude:35,longitude:139,accuracy:8,altitude:10,altitudeAccuracy:null}});} };
}
test('Opening/refreshing never asks for GPS', () => { const e=setup(); e.gps.refresh(); assert.equal(e.calls,0); });
test('Explicit start creates one watch, repeated start reuses it', () => {const e=setup();e.gps.start();e.gps.start();assert.equal(e.calls,1);});
test('Record starts GPS and awaits first fresh position', async()=>{const e=setup();const p=e.gps.getFresh();assert.equal(e.calls,1);e.fix();assert.equal((await p).lat,35);});
test('Timestamp prevents stale coordinate being reused',async()=>{const e=setup();e.gps.start();e.fix(30000);let resolved=false;const p=e.gps.getFresh().then(()=>resolved=true);await Promise.resolve();assert.equal(resolved,false);e.fix();await p;assert.equal(resolved,true);});
test('Fresh fix reused with no extra permission request',async()=>{const e=setup();e.gps.start();e.fix();await e.gps.getFresh();assert.equal(e.calls,1);});
test('Expired fix waits for new update',async()=>{const e=setup();e.gps.start();e.fix();e.tick(16000);let resolved=false;const p=e.gps.getFresh().then(()=>resolved=true);await Promise.resolve();assert.equal(resolved,false);e.fix();await p;});
test('Stop cancels pending record and ignores late callbacks',async()=>{const e=setup();const p=e.gps.getFresh();e.gps.stop('中止');await assert.rejects(p,/中止/);e.fix();assert.equal(e.state.position,null);assert.equal(e.clears,1);});
test('Permission denied fails visibly and allows an explicit retry',async()=>{const e=setup();const p=e.gps.getFresh();e.fail(1);await assert.rejects(p,/許可/);assert.equal(e.state.running,false);e.gps.start();assert.equal(e.calls,2);});
test('Timeout does not leave record waiting forever',async()=>{const e=setup();const p=e.gps.getFresh();e.timeout();await assert.rejects(p,/新しい位置/);});
test('Stationary stale watch requests a new one-shot position',async()=>{
  let now=100000, success, oneShot=0;
  const c=vm.createContext({setTimeout,clearTimeout});vm.runInContext(source,c);
  const fix=()=>({timestamp:now,coords:{latitude:35,longitude:139,accuracy:8}});
  const gps=c.CollectorGps.create({watchPosition(s){success=s;return 1;},clearWatch(){},getCurrentPosition(s){oneShot++;s(fix());}},()=>{},()=>now);
  gps.start();success(fix());now+=16000;await gps.getFresh();assert.equal(oneShot,1);
});
